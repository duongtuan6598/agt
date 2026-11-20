// Entry point of the AGT sealed box (runs INSIDE Google Confidential Space).
// 1. The AI's two keys are generated here and never leave the box (no env, no disk outside the VM, no logs).
// 2. The box asks the hardware-backed launcher for an attestation token bound to its manifest.
// 3. Evidence { manifest, token } is published (stdout + GET :8080/evidence) for the licence process.
// 4. Only then does it start the AGT app + CometBFT with those keys.
// Fail-closed: without a genuine attestation it exits — it never signs anything outside a sealed box.
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const { AUDIENCE, nonceOf, attestHashOf, charterHash } = require("../verify.js");

const RUN = "/run/agt";
const SOCK = "/run/container_launcher/teeserver.sock";
const ROOT = path.join(__dirname, "..", "..");
const log = (...a) => console.log(new Date().toISOString(), ...a);

function cometKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }).x;
  const seed = privateKey.export({ format: "jwk" }).d;
  const pubB = Buffer.from(pub, "base64url"), seedB = Buffer.from(seed, "base64url");
  const address = crypto.createHash("sha256").update(pubB).digest().subarray(0, 20).toString("hex").toUpperCase();
  return {
    pubB64: pubB.toString("base64"),
    file: {
      address,
      pub_key: { type: "tendermint/PubKeyEd25519", value: pubB.toString("base64") },
      priv_key: { type: "tendermint/PrivKeyEd25519", value: Buffer.concat([seedB, pubB]).toString("base64") },
    },
  };
}

function launcherToken(nonce) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCK)) return reject(new Error(`no Confidential Space launcher (${SOCK}) — refusing to run outside a sealed box`));
    const body = JSON.stringify({ audience: AUDIENCE, token_type: "OIDC", nonces: [nonce] });
    const req = http.request({ socketPath: SOCK, path: "/v1/token", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(t.trim()) : reject(new Error(`launcher ${res.statusCode}: ${t}`))));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function main() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const agent = ethers.Wallet.createRandom();
  const cmt = cometKeys();
  const manifest = {
    agt: "sealed-box-v1",
    chainId: process.env.AGT_CHAIN_ID || "agt-1",
    charterHash: charterHash(ROOT),
    promptHash: ethers.keccak256(fs.readFileSync(path.join(__dirname, "system-prompt.txt"))),
    agent: agent.address,
    cmtPubKey: cmt.pubB64,
  };
  log(`AI licence key ${agent.address} · CometBFT key ${cmt.pubB64} · manifest nonce ${nonceOf(manifest)}`);

  const token = await launcherToken(nonceOf(manifest));
  const evidence = { manifest, token };
  fs.writeFileSync(path.join(RUN, "evidence.json"), JSON.stringify(evidence));
  log(`AGT_EVIDENCE ${JSON.stringify(evidence)}`);
  log(`attestHash ${attestHashOf(evidence)} — give this evidence to the licence process`);
  http.createServer((req, res) => {
    if (req.url === "/evidence") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(evidence));
    res.writeHead(404).end();
  }).listen(8080);

  if (!process.env.AGT_GENESIS_URL) {
    log("no AGT_GENESIS_URL: serving evidence only — the chain starts once a genesis is given");
    return;
  }
  // CometBFT home inside the box; genesis + peers are public data the operator may point to.
  const home = path.join(RUN, "cmt");
  await run("cometbft", ["init", "--home", home]);
  fs.writeFileSync(path.join(home, "config", "priv_validator_key.json"), JSON.stringify(cmt.file), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "config", "genesis.json"), await (await fetch(process.env.AGT_GENESIS_URL)).text());
  const cf = path.join(home, "config", "config.toml");
  let t = fs.readFileSync(cf, "utf8");
  const set = (k, v) => (t = t.replace(new RegExp(`^${k} = .*$`, "m"), `${k} = ${v}`));
  set("proxy_app", '"127.0.0.1:26658"');
  set("abci", '"grpc"');
  if (process.env.AGT_PEERS) set("persistent_peers", JSON.stringify(process.env.AGT_PEERS));
  fs.writeFileSync(cf, t);

  // The AI key reaches the app only through this child's environment, inside the box.
  spawn("node", [path.join(ROOT, "chain", "abci", "app.js")], {
    stdio: "inherit",
    env: { ...process.env, AGENT_KEY: agent.privateKey, STATE_FILE: path.join(RUN, "app-state.json"), CMT_RPC: "http://127.0.0.1:26657" },
  }).on("exit", (c) => process.exit(c || 1));
  setTimeout(() => spawn("cometbft", ["node", "--home", home], { stdio: "inherit" }).on("exit", (c) => process.exit(c || 1)), 1500);
}

function run(cmd, args) {
  return new Promise((ok, bad) => spawn(cmd, args, { stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error(`${cmd} exited ${c}`)))));
}

main().catch((e) => {
  log("FATAL", e.message);
  process.exit(1);
});
