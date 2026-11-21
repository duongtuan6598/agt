// Local rehearsal of the embedded trade (docs/REHEARSAL.md, joint decision of 2026-11-21: local first, at no cost).
// Real: a chain (hardhat node), every contract, the EXAM SERVICE (exam-worker under `wrangler dev`, reading that
// chain), the client's git repository, and the sealed box's own wiring (tee/box/engage-wiring.js → EngageLoop,
// RepoMemoryStore, fileState, httpContent/httpSealed/httpRepro). Fake: the TEE (keys made here), the model and the
// client's CI. Nothing leaves this machine; no money is spent.
//   npx hardhat compile && node tools/rehearse-local.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RPC = "http://127.0.0.1:8545";
const EXAM = "http://127.0.0.1:8787";
const WRANGLER = process.env.AGT_WRANGLER || "C:/DuongTuan/coin/worker/node_modules/.bin/wrangler";
const GIT = process.platform === "win32" ? execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() : "git";
const art = (file, name) => require(path.join(ROOT, "artifacts", "contracts", file, `${name}.json`));
const E = (n) => ethers.parseEther(String(n));
const results = [];
const check = (ok, what) => { results.push({ ok, what }); console.log(`${ok ? "✔" : "✘"} ${what}`); };
const logs = [];
const boxLog = (...a) => { const l = a.join(" "); logs.push(l); if (process.env.VERBOSE) console.log("   [box]", l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProc(cmd, args, opts, ready) {
  const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let out = "";
  const done = new Promise((res, rej) => {
    const on = (d) => { out += d; if (ready.test(out)) res(); };
    p.stdout.on("data", on);
    p.stderr.on("data", on);
    p.on("exit", (c) => rej(new Error(`${cmd} exited ${c}:\n${out.slice(-2000)}`)));
    setTimeout(() => rej(new Error(`${cmd} not ready in time:\n${out.slice(-2000)}`)), 180000);
  });
  return { p, done, out: () => out };
}
function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} } else p.kill("SIGTERM");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agt-rehearse-"));
  const procs = [];
  try {
    // ---- 1. chain + contracts ----
    const node = startProc("npx", ["hardhat", "node", "--port", "8545"], { cwd: ROOT }, /Started HTTP/);
    procs.push(node.p);
    await node.done;
    const provider = new ethers.JsonRpcProvider(RPC);
    const sg = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
    const [founder, client, owner, V1, V2, V3] = sg;
    const deploy = async (file, name, ...args) => { const a = art(file, name); const c = await new ethers.ContractFactory(a.abi, a.bytecode, founder).deploy(...args); await c.waitForDeployment(); return c; };
    const xau = await deploy("test/Mocks.sol", "MockFeed", 8, 4000n * 10n ** 8n);
    const bnb = await deploy("test/Mocks.sol", "MockFeed", 8, 600n * 10n ** 8n);
    const oracle = await deploy("ChainlinkGoldOracle.sol", "ChainlinkGoldOracle", await founder.getAddress(), await xau.getAddress(), 3600);
    await (await oracle.setFeed(ethers.ZeroAddress, await bnb.getAddress(), 3600)).wait();
    const vault = await deploy("AGTVault.sol", "AGTVault", await founder.getAddress(), await oracle.getAddress());
    const work = await deploy("AGTWork.sol", "AGTWork", await founder.getAddress(), 50);
    const agt = await deploy("AGT.sol", "AGT", await vault.getAddress(), await work.getAddress());
    await (await vault.bind(await agt.getAddress())).wait();
    await (await work.bind(await agt.getAddress())).wait();
    await (await vault.setAsset(ethers.ZeroAddress, true)).wait();
    const eng = await deploy("Engagement.sol", "Engagement", await work.getAddress());
    const mnt = await deploy("Maintenance.sol", "Maintenance", await work.getAddress());
    // the AI's key: in production born in the sealed box; here a fresh key, funded with gas
    const boxWallet = ethers.Wallet.createRandom().connect(provider);
    await (await founder.sendTransaction({ to: boxWallet.address, value: E(10) })).wait();
    const ATT = ethers.id("sealed-box");
    await (await work.grantLicense(await owner.getAddress(), boxWallet.address, 1, ethers.id("w"), ATT, "embedded AI")).wait();
    for (const [i, v] of [V1, V2, V3].entries()) await (await work.grantLicense(await v.getAddress(), ethers.Wallet.createRandom().address, 2, ethers.id("v" + i), ATT, "reviewer " + i)).wait();
    await (await vault.connect(client).depositBNB(await client.getAddress(), { value: E(20) })).wait();
    await (await agt.connect(client).approve(await eng.getAddress(), E(100))).wait();
    check(true, "chain: contracts deployed, the AI licensed (worker, trade embedded), the client holds AGT");

    // ---- 2. the real exam service, reading this chain ----
    const vars = { BSC_RPC: RPC, CHAIN_ID: "31337", WORK: await work.getAddress(), ENGAGEMENT: await eng.getAddress(), MAINTENANCE: await mnt.getAddress() };
    const wr = startProc(WRANGLER, ["dev", "--local", "--port", "8787", "--persist-to", path.join(tmp, "kv"), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: path.join(ROOT, "exam-worker"), env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } }, /Ready on/);
    procs.push(wr.p);
    await wr.done;
    check(true, "exam service: exam-worker running locally against this chain");

    // ---- 3. the client: repository, brief, engagement, sealed access ----
    const bare = path.join(tmp, "client.git");
    execFileSync(GIT, ["init", "-q", "--bare", "-b", "main", bare]);
    const w0 = path.join(tmp, "w0");
    execFileSync(GIT, ["init", "-q", "-b", "main", w0]);
    fs.writeFileSync(path.join(w0, "main.c"), "int main(void){return 0;}\n");
    execFileSync(GIT, ["-C", w0, "add", "-A"]);
    execFileSync(GIT, ["-C", w0, "-c", "user.name=client", "-c", "user.email=c@c", "commit", "-q", "-m", "start"]);
    execFileSync(GIT, ["-C", w0, "push", "-q", bare, "main"]);
    const repoUrl = "file:///" + bare.split(path.sep).join("/");
    const Brief = require(path.join(ROOT, "public", "forms", "brief.js"));
    const FORM = require(path.join(ROOT, "public", "forms", "embedded.json"));
    const brief = Brief.build(FORM, { workType: "new", mcu: "STM32F407", resources: "1 MB / 192 KB", software: "C11", repository: repoUrl, ciChecks: ["build", "unit-tests"], description: "UART driver and logger", milestones: ["UART driver", "Logger"], maintenance: "no", memoryHandover: "private-repo" });
    const briefText = Brief.canonical(brief);
    const briefHash = ethers.keccak256(ethers.toUtf8Bytes(briefText));
    await (await eng.connect(client).open(1, briefHash, { amounts: [E(0.5), E(0.5)], hwBps: [0, 0], dueDays: [14, 28], holdbackBps: 0, warrantyDays: 30 })).wait();
    const id = Number(await eng.nextEngagement()) - 1;
    const post = async (p, body) => (await fetch(EXAM + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const rb = await post("/briefs", { contract: "engagement", id, text: briefText, signature: await client.signMessage(`AGT brief engagement ${id} ${briefHash}`) });
    check(rb.ok === true, `the client publishes the brief through the exam service (${rb.ok ? "accepted" : rb.error})`);
    const ESC = require(path.join(ROOT, "tee", "escrow.js"));
    const S = require(path.join(ROOT, "tee", "embedded", "secrets.js"));
    const master = ESC.newMaster(); // in production: escrowed between sealed boxes
    const keys = ESC.derive(master);
    const box = S.seal(keys.client.pub.toString("base64"), "token-for-this-repo", S.contextOf(31337, await eng.getAddress(), id));
    const version = Date.now();
    const boxText = JSON.stringify(box);
    const rs = await post("/sealed", { contract: "engagement", id, version, box, signature: await client.signMessage(`AGT sealed engagement ${id} ${version} ${ethers.keccak256(ethers.toUtf8Bytes(boxText))}`) });
    check(rs.ok === true, `the client seals repository access to the box (${rs.ok ? "stored as ciphertext" : rs.error})`);

    // ---- 4. the sealed box (production wiring), fake model and CI ----
    const { makeEngage } = require(path.join(ROOT, "tee", "box", "engage-wiring.js"));
    const model = {
      assess: async () => ({ feasible: true, reason: "embedded C, within the trade", questions: [], days: 7 }),
      engineer: async (w) => ({ files: [{ path: `src/${w.task.includes("Milestone 2") ? "log" : "uart"}.c`, content: `/* ${w.task.split("\n")[0]} */\nvoid f(void) {}\n` }], summary: "driver", cannot: "", memorySeen: w.memory }),
    };
    const seen = [];
    const ci = { status: async (q) => ({ state: "success", checks: q.required.map((name) => ({ name, conclusion: "success", url: `local://${q.sha}` })), failures: "" }) };
    const vm = (n) => makeEngage({
      env: { ENGAGEMENT: vars.ENGAGEMENT, MAINTENANCE: vars.MAINTENANCE, AGT_EXAM_URL: EXAM }, wallet: boxWallet,
      model: { ...model, engineer: async (w) => { seen.push({ vm: n, memory: w.memory }); return model.engineer(w); } },
      keys, verifyBuilder: () => false, log: boxLog, ci, allowFileUrls: true, gitBin: GIT,
      dirs: { mem: path.join(tmp, `vm${n}`, "memory"), state: path.join(tmp, `vm${n}`, "state"), ws: path.join(tmp, `vm${n}`, "ws") },
    });
    const visibility = async () => "private"; // a file:// repository has no forge to ask
    let A = await vm(1);
    A.visibility = visibility;
    await A.step(); // accept
    const e1 = await eng.engagements(id);
    check(Number(e1.startedAt) > 0, "the AI accepts the engagement on chain");
    await A.step(); // round 1 pushed
    await A.step(); // CI passed → delivered
    const m0 = await eng.milestone(id, 0);
    check(Number(m0.state) === 2 && m0.report !== ethers.ZeroHash, "milestone 1 delivered on chain after the client's CI passed");
    const rep = await (await fetch(`${EXAM}/content/${m0.report}`)).json();
    let head1 = null;
    try { head1 = JSON.parse(rep.text).memoryHead; } catch {}
    check(rep.ok === true && /^[0-9a-f]{64}$/.test(String(head1)), "the delivery report is served by the exam service and anchors the memory head");
    const branches = execFileSync(GIT, ["--git-dir", bare, "branch", "--list"], { encoding: "utf8" });
    check(/agt\/memory/.test(branches) && /agt\/engagement-\d+-m1/.test(branches), "the client's repository holds the AI's branch and its encrypted memory (agt/memory)");
    await (await eng.connect(client).accept(id, 0)).wait();

    // ---- 5. the VM is replaced: same escrowed keys, empty disk ----
    const B = await vm(2);
    B.visibility = visibility;
    await B.step(); // milestone 2, round 1
    const firstOnB = seen.find((x) => x.vm === 2);
    check(!!firstOnB && /Milestone 1/.test(firstOnB.memory || ""), "a replaced VM reads the whole memory back from the client's repository and uses it");
    await B.step();
    const m1 = await eng.milestone(id, 1);
    check(Number(m1.state) === 2, "the replaced VM delivers milestone 2");

    // ---- 6. the memory branch is rewound: the AI stops on this contract ----
    await (await eng.connect(client).requestRevision(id, 1, ethers.id("please add a timestamp"))).wait();
    const memLog = execFileSync(GIT, ["--git-dir", bare, "log", "--format=%H", "agt/memory"], { encoding: "utf8" }).trim().split("\n");
    const goodHead = memLog[0];
    execFileSync(GIT, ["--git-dir", bare, "update-ref", "refs/heads/agt/memory", memLog[memLog.length - 1]]);
    const before = seen.length;
    logs.length = 0;
    await B.step();
    check(seen.length === before && logs.some((l) => /MEMORY PROBLEM/.test(l)), "after a rollback of agt/memory the AI does no work on that contract and says why");
    execFileSync(GIT, ["--git-dir", bare, "update-ref", "refs/heads/agt/memory", goodHead]);
    const delivered2 = execFileSync(GIT, ["--git-dir", bare, "rev-parse", "agt/engagement-" + id + "-m2"], { encoding: "utf8" }).trim();
    logs.length = 0;
    await B.step(); // the model gives the same file again: must NOT be presented as the revision
    const sameAgain = execFileSync(GIT, ["--git-dir", bare, "rev-parse", "agt/engagement-" + id + "-m2"], { encoding: "utf8" }).trim();
    check(seen.length > before && sameAgain === delivered2 && logs.some((l) => /changes nothing/.test(l)), "once the branch is restored the AI resumes; an answer that changes nothing is not passed off as a revision");
    model.engineer = async () => ({ files: [{ path: "src/log.c", content: "/* with timestamp */\nvoid f(void) {}\n" }], summary: "timestamp added", cannot: "" });
    await B.step(); // pushed
    await B.step(); // CI passed → redelivered
    const m1b = await eng.milestone(id, 1);
    check(Number(m1b.state) === 2 && Number(m1b.revisions) === 1, "the revision is redelivered with a new commit");
    await (await eng.connect(client).accept(id, 1)).wait();
    try { await (await eng.connect(client).end(id)).wait(); } catch (e) { boxLog(`end: ${e.shortMessage || e.message}`); }
    const ended = (await eng.engagements(id)).ended;
    if (ended) {
      await B.step();
      const exported = execFileSync(GIT, ["--git-dir", bare, "branch", "--list", "agt/memory-export-*"], { encoding: "utf8" });
      check(/agt\/memory-export-/.test(exported), "after the end, the memory is handed over in plain text (asked for in the brief)");
    } else check(false, "the client could not end the engagement");
  } catch (e) {
    check(false, `rehearsal stopped: ${e.message.split("\n")[0]}`);
    if (process.env.VERBOSE) console.error(e);
  } finally {
    for (const p of procs.reverse()) killTree(p);
    if (process.env.VERBOSE) console.log(logs.slice(-30).join("\n"));
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
}

main();
