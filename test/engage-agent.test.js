// The sealed AI's long-term work loop (tee/embedded/engage-agent.js) against the real contracts, a real git
// repository (local, file://) and the client's token sealed to the box. The model and the N1–N4 tools are fakes
// here (the real tools are proven in the embedded image).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ESC = require("../tee/escrow.js");
const E = (n) => ethers.parseEther(String(n));
const S = require("../tee/embedded/secrets.js");
const Brief = require("../public/forms/brief.js");
const FORM = require("../public/forms/embedded.json");
const { EngageLoop } = require("../tee/embedded/engage-agent.js");

const ATT = ethers.id("sealed-box");
const DAY = 86400;
// The workspace runs git with a minimal PATH on purpose, so it needs git's full path.
const GIT = process.env.AGT_TEST_GIT || (process.platform === "win32" ? execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() : execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());
const sh = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "c", GIT_AUTHOR_EMAIL: "c@c", GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@c" } });

function clientRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-client-"));
  const bare = path.join(dir, "repo.git");
  const src = path.join(dir, "src");
  sh(["init", "-q", "--bare", bare]);
  sh(["init", "-q", src]);
  fs.writeFileSync(path.join(src, "main.c"), "int main(void) { return 0; }\n");
  fs.mkdirSync(path.join(src, "tests"));
  fs.writeFileSync(path.join(src, "tests", "test_uart.c"), "/* the client's test */\n");
  sh(["add", "-A"], src);
  sh(["commit", "-q", "-m", "initial"], src);
  sh(["push", "-q", bare, "HEAD:refs/heads/main"], src);
  sh(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { url: "file:///" + bare.split(path.sep).join("/"), bare, dir };
}

async function world() {
  const s = await ethers.getSigners();
  const [founder, client, W, V1, V2, V3] = s;
  const wAI = s[10];
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const bnb = await Feed.deploy(8, 600n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  await oracle.setFeed(ethers.ZeroAddress, bnb, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 50);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  await vault.setAsset(ethers.ZeroAddress, true);
  await work.grantLicense(W.address, wAI.address, 1, ethers.id("w"), ATT, "embedded AI"); // licence 1
  for (const [i, v] of [V1, V2, V3].entries()) await work.grantLicense(v.address, s[11 + i].address, 2, ethers.id("v" + i), ATT, "reviewer " + i);
  await vault.connect(client).depositBNB(client.address, { value: E(20) });
  const eng = await (await ethers.getContractFactory("Engagement")).deploy(work);
  const mnt = await (await ethers.getContractFactory("Maintenance")).deploy(work);
  await agt.connect(client).approve(eng, E(100));
  await agt.connect(client).approve(mnt, E(100));

  const repo = clientRepo();
  const store = new Map();
  const content = { put: async (t) => { const h = ethers.keccak256(ethers.toUtf8Bytes(t)); store.set(h, t); return h; }, get: async (h) => { if (!store.has(h)) throw new Error("not found"); return store.get(h); } };
  const keys = ESC.derive(ESC.newMaster());
  const sealedBoxes = new Map();
  const sealFor = (kind, id, token = "token-for-this-repo") => sealedBoxes.set(`${kind}:${id}`, S.seal(keys.client.pub.toString("base64"), token, S.contextOf(31337, kind === "engagement" ? eng.target : mnt.target, id)));
  const calls = { engineer: [] };
  const model = {
    assess: async () => ({ feasible: true, reason: "embedded C, within the trade", questions: [], days: 7 }),
    engineer: async (w) => { calls.engineer.push(w); return model.next(w); },
    next: async (w) => ({ files: [{ path: "src/uart.c", content: `/* ${w.task.split("\n")[0]} */\nvoid uart_init(void) {}\n` }], summary: "UART driver", cannot: "" }),
    judge: async () => ({ verdict: "accept", reason: "every criterion met" }),
  };
  const okPart = (level) => ({ level, ok: true });
  const tools = {
    checks: [],
    build: async ({ dir }) => { tools.checks.push(dir); return { ...okPart("N1"), sha256: "ab" }; },
    unitTests: async () => okPart("N2"), simulate: async () => okPart("N3"), size: async () => ({ ...okPart("N4"), check: "size" }),
    staticAnalysis: async () => ({ ...okPart("N4"), check: "static", newFindings: [] }),
    report: (parts, o) => ({ ok: parts.every((p) => p.ok), text: JSON.stringify({ parts, ...o }), hash: "0x" + "11".repeat(32) }),
  };
  const memStore = (() => { const m = new Map(); return { put: async (k, v) => void m.set(k, v), get: async (k) => m.get(k) ?? null, list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }; })();
  const loop = (signer, extra = {}) => new EngageLoop({
    eng: eng.connect(signer), mnt: mnt.connect(signer), me: signer.address, chainId: 31337, content,
    sealed: { get: async (kind, id) => sealedBoxes.get(`${kind}:${id}`) || null },
    model, tools, keys, memStore, wsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "agt-ws-")), allowFileUrls: true, gitBin: GIT, ...extra,
  });
  const brief = (over = {}) => Brief.build(FORM, {
    workType: "new", mcu: "STM32F407", resources: "1 MB / 192 KB", software: "C11", repository: repo.url,
    buildCommand: "make", artifact: "firmware.elf", simTarget: "none", description: "UART driver and logger", milestones: ["UART driver", "Logger"],
    maintenance: "no", pinnedTests: [["tests/test_uart.c", "ab".repeat(32)]], ...over,
  });
  async function open(b = brief(), plan = { amounts: [E(0.5), E(0.5)], hwBps: [0, 0], dueDays: [14, 28], holdbackBps: 0, warrantyDays: 30 }) {
    const text = Brief.canonical(b);
    const h = await content.put(text);
    await eng.connect(client).open(1, h, plan);
    return Number(await eng.nextEngagement()) - 1;
  }
  return { s, work, agt, eng, mnt, client, W, wAI, repo, content, keys, sealFor, model, calls, tools, loop, open, brief, store };
}

const branchFile = (bare, branch, file) => execFileSync("git", ["--git-dir", bare, "show", `${branch}:${file}`], { encoding: "utf8" });

describe("Sealed AI long-term work loop (tee/embedded/engage-agent.js)", function () {
  this.timeout(60000);

  it("accepts the engagement, waits for repository access, then builds, checks, pushes a branch and delivers", async () => {
    const { eng, wAI, repo, sealFor, loop, open, store } = await world();
    const id = await open();
    const ai = loop(wAI);
    await ai.step();
    expect(Number((await eng.engagements(id)).startedAt)).to.be.gt(0); // accepted after reading the brief
    expect(Number((await eng.milestone(id, 0)).state)).to.equal(1); // no token yet: nothing delivered
    sealFor("engagement", id);
    await ai.step();
    const m = await eng.milestone(id, 0);
    expect(Number(m.state)).to.equal(2); // Delivered
    const sha = m.result.slice(2, 42);
    expect(branchFile(repo.bare, `agt/engagement-${id}-m1`, "src/uart.c")).to.contain("Milestone 1 of 2: UART driver");
    expect(execFileSync("git", ["--git-dir", repo.bare, "rev-parse", `agt/engagement-${id}-m1`], { encoding: "utf8" }).trim()).to.equal(sha);
    expect(store.get(m.report)).to.contain("memoryHead"); // the N1–N4 report is public, anchored to the memory
    expect(execFileSync("git", ["--git-dir", repo.bare, "rev-parse", "main"], { encoding: "utf8" }).trim()).to.not.equal(sha); // never the main branch
  });

  it("never delivers work whose checks fail; retries with the failure log; pinned client tests cannot be changed", async () => {
    const { eng, wAI, sealFor, loop, open, model, calls, tools } = await world();
    const id = await open();
    sealFor("engagement", id);
    let round = 0;
    model.next = async () => (++round === 1 ? { files: [{ path: "tests/test_uart.c", content: "/* weakened */" }], summary: "", cannot: "" } : { files: [{ path: "src/uart.c", content: "bad" }], summary: "", cannot: "" });
    tools.build = async () => ({ level: "N1", ok: false, log: "uart.c:1: error: expected ';'" });
    await loop(wAI).step();
    expect(Number((await eng.milestone(id, 0)).state)).to.equal(1); // still waiting: nothing delivered
    expect(calls.engineer.length).to.equal(3);
    expect(calls.engineer[1].failure).to.contain("pinned"); // the pinned test file was refused
    expect(calls.engineer[2].failure).to.contain("expected ';'"); // the build log goes back to the model
  });

  it("a revision request: the AI reads the client's note and redelivers", async () => {
    const { eng, client, wAI, sealFor, loop, open, content, calls } = await world();
    const id = await open();
    sealFor("engagement", id);
    const ai = loop(wAI);
    await ai.step();
    await ai.step();
    const note = "Use DMA for UART TX, not polling.";
    await eng.connect(client).requestRevision(id, 0, await content.put(note));
    await ai.step();
    expect(calls.engineer.at(-1).notes).to.equal(note);
    expect(Number((await eng.milestone(id, 0)).state)).to.equal(2);
  });

  it("a warranty claim gets a fix on its own branch", async () => {
    const { eng, client, wAI, repo, sealFor, loop, open, content } = await world();
    const id = await open(undefined, { amounts: [ethers.parseEther("1")], hwBps: [0], dueDays: [14], holdbackBps: 2000, warrantyDays: 90 });
    sealFor("engagement", id);
    const ai = loop(wAI);
    await ai.step();
    await ai.step();
    await eng.connect(client).accept(id, 0);
    await eng.connect(client).claimWarranty(id, 0, await content.put("Watchdog resets after 2 h at 85 °C."));
    await ai.step();
    const m = await eng.milestone(id, 0);
    expect(m.fix).to.not.equal(ethers.ZeroHash);
    expect(branchFile(repo.bare, `agt/engagement-${id}-m1-warranty`, "src/uart.c")).to.contain("Warranty claim");
  });

  it("maintenance: accepts, acknowledges incidents at once, fixes and resolves them", async () => {
    const { mnt, client, wAI, sealFor, loop, brief, content } = await world();
    const b = brief({ workType: "maintenance", maintenance: "yes", milestones: ["Monthly maintenance"] });
    await mnt.connect(client).open(1, await content.put(Brief.canonical(b)), ethers.parseEther("0.1"), 1000);
    const id = Number(await mnt.nextRetainer()) - 1;
    const ai = loop(wAI);
    await ai.step();
    expect(Number((await mnt.retainers(id)).startedAt)).to.be.gt(0);
    sealFor("maintenance", id);
    await mnt.connect(client).report(id, 2, await content.put("CVE-2026-1234 in mbedTLS 3.5"));
    await ai.step();
    const x = await mnt.incident(id, 0);
    expect(Number(x.ackAt)).to.be.gt(0);
    expect(Number(x.fixAt)).to.be.gt(0);
    expect(x.fix).to.not.equal(ethers.ZeroHash);
  });

  it("a token sealed for another contract, or by someone to another box, is useless", async () => {
    const { eng, wAI, loop, open, keys } = await world();
    const id = await open();
    const other = ESC.derive(ESC.newMaster());
    const sealed = new Map([[`engagement:${id}`, S.seal(other.client.pub.toString("base64"), "t", S.contextOf(31337, eng.target, id))]]);
    const ai = loop(wAI, { sealed: { get: async (k, n) => sealed.get(`${k}:${n}`) || null } });
    await ai.step();
    await ai.step().catch(() => {});
    expect(Number((await eng.milestone(id, 0)).state)).to.equal(1); // nothing delivered
    expect(keys).to.be.ok;
  });

  it("disputes: anyone draws; a drawn reviewer AI judges and votes", async () => {
    const { s, eng, client, wAI, sealFor, loop, open } = await world();
    const id = await open();
    sealFor("engagement", id);
    const ai = loop(wAI);
    await ai.step();
    await ai.step();
    await eng.connect(client).dispute(id, 0);
    await mine(3);
    await ai.step(); // the worker's loop draws the reviewers
    const d = (await eng.milestone(id, 0)).dispute;
    expect((await eng.disputes(d)).drawnAt).to.be.gt(0n);
    for (const r of s.slice(11, 14)) await loop(r).step(); // reviewer boxes: only the drawn ones vote
    expect(Number((await eng.milestone(id, 0)).state)).to.not.equal(5); // decided
  });
});
