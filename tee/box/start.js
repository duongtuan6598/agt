// Entry point of the AGT sealed box (runs INSIDE Google Confidential Space).
//  1. Keys: recovered from peer boxes after a restart (AGT_ESCROW_URL), or a fresh master on first boot.
//     Every key derives from that master, which never leaves the box (no env, no logs, no disk outside the VM).
//  2. Attestation token bound to the manifest → evidence { manifest, token } (stdout + GET :8080/evidence).
//  3. First boot with peers: escrow the master with attested peer boxes → record (stdout + GET :8080/escrow).
//  4. Serve escrow releases for OTHER boxes (POST :8080/escrow/release) — only to genuine boxes on the same machine.
//  5. Optional: sit the licence exam itself (AGT_EXAM_URL), signing with its own key.
//  6. With a genesis: run the AGT app + CometBFT with those keys.
// Fail-closed: without a genuine attestation it exits — it never signs anything outside a sealed box.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const T = require("../verify.js");
const E = require("../escrow.js");

const RUN = "/run/agt";
const SOCK = "/run/container_launcher/teeserver.sock";
const ROOT = path.join(__dirname, "..", "..");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const env = process.env;
// The policy that decides which PEERS are trusted is baked into the image — never taken from the operator.
const POLICY = T.loadPolicy(path.join(ROOT, "tee", "policy.json"));

function launcherToken(nonce) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCK)) return reject(new Error(`no Confidential Space launcher (${SOCK}) — refusing to run outside a sealed box`));
    const body = JSON.stringify({ audience: T.AUDIENCE, token_type: "OIDC", nonces: [nonce] });
    const req = http.request({ socketPath: SOCK, path: "/v1/token", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(t.trim()) : reject(new Error(`launcher ${res.statusCode}: ${t}`))));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

// ---------- platform: Google Confidential Space, or dstack on Intel TDX (any TDX server, no cloud needed) ----------
const DSTACK_SOCKS = ["/var/run/dstack.sock", "/run/dstack.sock", "/var/run/dstack/dstack.sock", "/run/dstack/dstack.sock"];
const dstackSock = () => DSTACK_SOCKS.find((p) => fs.existsSync(p));
function unixPost(sock, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath: sock, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(t)) : reject(new Error(`dstack ${urlPath} ${res.statusCode}: ${t}`))));
    });
    req.on("error", reject);
    req.end(data);
  });
}
// Attestation bound to `manifest` (its hash is the nonce / report_data).
async function attest(manifest) {
  const nonce = T.nonceOf(manifest);
  if (env.AGT_SKR_URL) {
    // Azure Confidential Containers: the SKR sidecar returns the raw SNP report and the AMD chain.
    const r = await getJson(`${env.AGT_SKR_URL}/attest/combined`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime_data: Buffer.from(nonce, "hex").toString("base64") }) });
    return { platform: "azure-snp", report: Buffer.from(r.evidence, "base64").toString("hex"), certChain: Buffer.from(r.endorsements, "base64").toString("utf8") };
  }
  const ds = dstackSock();
  if (ds) {
    const r = await unixPost(ds, "/GetQuote", { report_data: nonce });
    return { platform: "dstack-tdx", quote: r.quote, eventLog: r.event_log };
  }
  return { token: await launcherToken(nonce) };
}
// Claims about THIS box, read from its own attestation (trusted: it was just produced here).
function ownClaims(att) {
  if (att.platform === "azure-snp") {
    const r = require("../snp.js").parseReport(att.report);
    return { platform: "azure-snp", measurement: r.measurement, submods: { container: { image_digest: `ccepolicy:${r.hostData}` }, gce: { project_id: "azure-aci", instance_id: r.chipId } } };
  }
  if (att.platform !== "dstack-tdx") return claimsOf(att.token);
  const ev = {};
  for (const e of JSON.parse(att.eventLog)) if (e.imr === 3) ev[e.event] = e.event_payload;
  return { platform: "dstack-tdx", submods: { container: { image_digest: `compose:${ev["compose-hash"]}` }, gce: { project_id: `dstack:${ev["app-id"] || ""}`, instance_id: ev["instance-id"] } } };
}
const peers = () => (env.AGT_PEER_BOXES || "").split(",").map((s) => s.trim()).filter(Boolean);
async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function recoverMaster(jwks) {
  const record = await getJson(env.AGT_ESCROW_URL);
  const req = E.releaseRequest(record);
  const att = await attest(req.manifest);
  const replies = [];
  for (const url of peers()) {
    try {
      replies.push(await getJson(`${url}/escrow/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ record, request: { manifest: req.manifest, ...att } }) }));
      log(`share received from ${url}`);
    } catch (e) {
      log(`no share from ${url}: ${e.message}`);
    }
  }
  const master = E.recover({ record, key: req.key, replies });
  log(`keys recovered from ${replies.length} peer boxes — same AI ${record.agent}, no new licence needed`);
  return { master, record };
}

async function main() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // Google's signing keys. A TEST image (never the published one) bakes its own test keys instead —
  // it has a different image digest, so real boxes never trust it.
  const TEST_JWKS = path.join(ROOT, "tee", "test-jwks.json");
  const jwks = fs.existsSync(TEST_JWKS) ? (log("TEST IMAGE: using baked test JWKS"), JSON.parse(fs.readFileSync(TEST_JWKS, "utf8"))) : await T.fetchJwks().catch(() => null);
  // Peers on Intel/AMD hardware are checked with fresh vendor collateral (patch level + revocation).
  const C = require("../collateral.js");
  const collateralCache = new Map();
  const collateralFor = async (att) => {
    const key = att.platform === "dstack-tdx" ? att.quote.slice(0, 2000) : att.platform === "azure-snp" ? att.certChain : "gcp";
    if (!collateralCache.has(key)) collateralCache.set(key, await C.forAttestation(att).catch(() => ({})));
    return collateralCache.get(key);
  };
  const verifyEv = (ev, collateral) => T.verifyEvidence(ev, { jwks, policy: POLICY, collateral });
  const verifyToken = (r, collateral) => T.verifyAttestation(r, { jwks, policy: POLICY, collateral });

  // 1. Keys
  let master, record = null;
  if (env.AGT_ESCROW_URL) ({ master, record } = await recoverMaster(jwks));
  else master = E.newMaster();
  const k = E.derive(master);
  const M = require("./models.js");
  const provider = env.AGT_MODEL_PROVIDER || "anthropic";
  const model = M.modelIdentity(provider); // refuses providers that are not approved in the image

  // 2. Evidence
  const manifest = {
    agt: "sealed-box-v1",
    chainId: env.AGT_CHAIN_ID || "agt-1",
    charterHash: T.charterHash(ROOT),
    promptHash: require("ethers").keccak256(fs.readFileSync(path.join(__dirname, "system-prompt.txt"))),
    agent: k.agent.address,
    cmtPubKey: k.cmtPub.toString("base64"),
    sealPubKey: k.seal.pub.toString("base64"),
    clientPubKey: k.client.pub.toString("base64"), // clients seal repo tokens and other secrets to this key
    model, // which model this AI thinks with — attested together with the code
  };
  log(`AI licence key ${k.agent.address} · CometBFT key ${manifest.cmtPubKey} · manifest nonce ${T.nonceOf(manifest)}`);
  const att = await attest(manifest);
  const evidence = { manifest, ...att };
  const mine = ownClaims(att);
  // Peers running EXACTLY this image run exactly this code: trust them as well as Council-approved images.
  if (att.platform === "azure-snp") {
    POLICY.azureAci = POLICY.azureAci || { hostData: [], measurements: [] };
    POLICY.azureAci.hostData = [...new Set([...POLICY.azureAci.hostData, mine.submods.container.image_digest.slice("ccepolicy:".length)])];
    POLICY.azureAci.measurements = [...new Set([...POLICY.azureAci.measurements, mine.measurement])];
  } else if (att.platform === "dstack-tdx") {
    // same compose + same dstack OS as me = same code: trust it (plus Council-approved ones)
    const body = require("../tdx.js").parseQuote(att.quote).body;
    POLICY.dstack = POLICY.dstack || { osImages: [], composeHashes: [] };
    POLICY.dstack.osImages = [...POLICY.dstack.osImages, { mrTd: body.mrTd, rtmr0: body.rtmr0, rtmr1: body.rtmr1, rtmr2: body.rtmr2 }];
    POLICY.dstack.composeHashes = [...new Set([...POLICY.dstack.composeHashes, mine.submods.container.image_digest.slice("compose:".length)])];
  } else POLICY.imageDigests = [...new Set([...POLICY.imageDigests, mine.submods.container.image_digest])];
  fs.writeFileSync(path.join(RUN, "evidence.json"), JSON.stringify(evidence));
  log(`AGT_EVIDENCE ${JSON.stringify(evidence)}`);
  log(`attestHash ${T.attestHashOf(evidence)} — give this evidence to the licence process`);

  // 3. Escrow on first boot
  if (!record && peers().length && jwks) {
    try {
      const peerEvidence = [];
      for (const url of peers()) {
        const ev = await getJson(`${url}/evidence`).catch(() => null);
        if (ev) peerEvidence.push({ evidence: ev, collateral: await collateralFor(ev) });
      }
      record = await E.makeEscrow({ master, myClaims: mine, peers: peerEvidence, verify: (ev) => verifyEv(ev, peerEvidence.find((p) => p.evidence === ev).collateral) });
      log(`AGT_ESCROW ${JSON.stringify(record)}`);
      log(`keys escrowed with ${record.shares.length} attested peer boxes (any ${record.threshold} can restore them, only to this machine)`);
    } catch (e) {
      log(`escrow not made (${e.message}) — a restart of this VM will need a new licence`);
    }
  } else if (!record) log("no peer boxes given — keys live only in this VM; a restart will need a new licence");

  // 4. HTTP: evidence, escrow record, releases for other boxes
  http.createServer((req, res) => {
    const send = (code, obj) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
    if (req.method === "GET" && req.url === "/evidence") return send(200, evidence);
    if (req.method === "GET" && req.url === "/escrow") return record ? send(200, record) : send(404, { error: "no escrow" });
    if (req.method === "POST" && req.url === "/escrow/release") {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        (async () => {
          try {
            const { record: r, request } = JSON.parse(b);
            const collateral = await collateralFor(request);
            send(200, E.releaseShare({ myMaster: master, record: r, request, verifyToken: (x) => verifyToken(x, collateral) }));
          } catch (e) {
            send(403, { error: e.message });
          }
        })();
      });
      return;
    }
    send(404, { error: "not found" });
  }).listen(8080);

  // 5. Exam, sat by the AI inside the box
  if (env.AGT_EXAM_URL) {
    try {
      const { sit } = require("../../exam-worker/client.js");
      const { makeAnswerer, secretFromManager } = require("./answer.js");
      if (provider === "local") await startLocalModel();
      const apiKey = provider === "local" ? null : await secretFromManager(env.AGT_MODEL_KEY_SECRET);
      const systemPrompt = fs.readFileSync(path.join(__dirname, "system-prompt.txt"), "utf8");
      const r = await sit({ base: env.AGT_EXAM_URL, owner: require("../../chain/address.js").toHex(env.AGT_OWNER), agentKey: k.agent.privateKey, name: env.AGT_AI_NAME || "AGT box", trade: Number(env.AGT_TRADE || 1), answersFor: makeAnswerer({ apiKey, systemPrompt, provider }) });
      log(`AGT_EXAM ${JSON.stringify({ agent: r.agent, examHash: r.result.examHash, status: r.result.status, passed: r.result.passed, total: r.result.total })}`);
    } catch (e) {
      log(`exam failed: ${e.message}`);
    }
  }

  // 6. Work: once licensed, the AI works by itself (worker: translate open tasks; verifier: review when drawn).
  if (env.AGT1_RPC) startWork(k.agent.privateKey, provider, k).catch((e) => log(`work loop stopped: ${e.message}`));

  // 7. Chain
  if (!env.AGT_GENESIS_URL) return log("no AGT_GENESIS_URL: serving evidence only — the chain starts once a genesis is given");
  const home = path.join(RUN, "cmt");
  await run("cometbft", ["init", "--home", home]);
  const pvk = {
    address: require("crypto").createHash("sha256").update(k.cmtPub).digest().subarray(0, 20).toString("hex").toUpperCase(),
    pub_key: { type: "tendermint/PubKeyEd25519", value: k.cmtPub.toString("base64") },
    priv_key: { type: "tendermint/PrivKeyEd25519", value: Buffer.concat([k.cmtSeed, k.cmtPub]).toString("base64") },
  };
  fs.writeFileSync(path.join(home, "config", "priv_validator_key.json"), JSON.stringify(pvk), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config", "genesis.json"), await (await fetch(env.AGT_GENESIS_URL)).text());
  const cf = path.join(home, "config", "config.toml");
  let t = fs.readFileSync(cf, "utf8");
  const set = (key, v) => (t = t.replace(new RegExp(`^${key} = .*$`, "m"), `${key} = ${v}`));
  set("proxy_app", '"127.0.0.1:26658"');
  set("abci", '"grpc"');
  if (env.AGT_PEERS) set("persistent_peers", JSON.stringify(env.AGT_PEERS));
  fs.writeFileSync(cf, t);
  spawn("node", [path.join(ROOT, "chain", "abci", "app.js")], {
    stdio: "inherit",
    env: { ...env, AGENT_KEY: k.agent.privateKey, STATE_FILE: path.join(RUN, "app-state.json"), CMT_RPC: "http://127.0.0.1:26657" },
  }).on("exit", (c) => process.exit(c || 1));
  setTimeout(() => spawn("cometbft", ["node", "--home", home], { stdio: "inherit" }).on("exit", (c) => process.exit(c || 1)), 1500);
}

let localModel = null;
async function startLocalModel() {
  if (localModel) return localModel;
  const M = require("./models.js");
  const weights = await M.fetchLocalWeights(path.join(RUN, "model.gguf")); // refused unless the pinned sha256 matches
  localModel = spawn("llama-server", ["-m", weights, "--host", "127.0.0.1", "--port", "8081"], { stdio: "inherit" });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch("http://127.0.0.1:8081/health")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  log("local model ready inside the box");
  return localModel;
}

async function startWork(agentKey, modelProvider = "anthropic", keys = null) {
  const { ethers } = require("ethers");
  const { makeModel } = require("./models.js");
  const { secretFromManager } = require("./answer.js");
  if (modelProvider === "local") await startLocalModel();
  const apiKey = modelProvider === "local" ? null : await secretFromManager(env.AGT_MODEL_KEY_SECRET);
  const systemPrompt = fs.readFileSync(path.join(__dirname, "system-prompt.txt"), "utf8");
  const wallet = new ethers.Wallet(agentKey);
  // The AI works on AGT's own chain agt-2 and nowhere else: no other chain, no gas, nothing to fund.
  log(`work loop: AI ${wallet.address} on agt-2 (${env.AGT1_RPC})`);
  // Long-term work (embedded trade). §12 (joint decision of Claude and Codex): the client's code never runs in this
  // box; its own CI runs N1–N4. The TEE sockets are still locked to root as defence in depth (tee/embedded/isolation.js).
  let engage = null;
  if (keys && fs.existsSync(path.join(__dirname, "..", "embedded", "engage-agent.js"))) {
    require("../embedded/isolation.js").lockDown(log);
    // §14–§15: builders are trusted only with an attested image on policy.builderImages (none approved yet)
    const verifyBuilder = require("../builder/verify-builder.js").makeVerifyBuilder({ jwks: await T.fetchJwks(), policy: POLICY, log });
    engage = await require("./engage-wiring.js").makeEngage({ env, wallet, model: makeModel({ provider: modelProvider, apiKey, systemPrompt }), keys, verifyBuilder, log });
    log("long-term work: contracts on agt-2");
  }
  // Own work found by the AI itself (THIET-KE-AI-TU-CHU.md): with the GitHub account its owner gave it, it fixes
  // open issues of open-source projects; merged work is submitted on agt-2 and checked by reviewers of other owners.
  const a1 = require("../../chain/agt1-client.js").connect(env.AGT1_RPC);
  let gh = null, hunter = null;
  if (env.AGT_GITHUB_TOKEN_SECRET) {
    const { github } = require("../embedded/github.js");
    gh = github({ token: await secretFromManager(env.AGT_GITHUB_TOKEN_SECRET, "AGT_GITHUB_TOKEN") });
    const { OssHunter } = require("../embedded/oss-hunt.js");
    hunter = new OssHunter({ gh, a1, wallet, model: makeModel({ provider: modelProvider, apiKey, systemPrompt }), Workspace: require("../embedded/workspace.js").Workspace, owner: env.AGT_OWNER, log });
    log("own work: open-source issues with the AI's own GitHub account");
  }
  // Per-job work (translation of open documents) and reviewing other owners' jobs of the same trade, on agt-2.
  const { Agt1WorkLoop } = require("./agt1-work.js");
  // open tasks come from agt-2 itself (anyone publishes one as content agt-task/v1)
  const jobs = new Agt1WorkLoop({ a1, wallet, tasks: () => a1.tasks(Number(env.AGT_TRADE || 1)), model: makeModel({ provider: modelProvider, apiKey, systemPrompt }), log, gh });
  log("per-job work and reviews on agt-2");
  for (;;) {
    if (engage) try { await engage.step(); } catch (e) { log(`long-term work: ${e.shortMessage || e.message}`); }
    if (hunter) try { await hunter.step(); } catch (e) { log(`own work: ${e.message}`); }
    if (jobs) try { await jobs.step(); } catch (e) { log(`work: ${e.shortMessage || e.message}`); }
    await new Promise((r) => setTimeout(r, Number(env.AGT_WORK_EVERY_SEC || 600) * 1000));
  }
}

function run(cmd, args) {
  return new Promise((ok, bad) => spawn(cmd, args, { stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error(`${cmd} exited ${c}`)))));
}

main().catch((e) => {
  log("FATAL", e.message);
  process.exit(1);
});
