// The sealed AI's work loop against real contracts: a worker AI translates an open task and submits it,
// the reviewer draw runs, the drawn verifier AIs review and vote — a fake model stands in for Claude.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const { AgentLoop, WORK_ABI, parseUri } = require("../tee/box/agent.js");

const ATT = ethers.id("sealed-box");
const TASKS = [
  { id: "doc-a", title: "A", glossary: [["backup", "bản sao lưu"]], source: "Keep a backup." },
  { id: "doc-b", title: "B", glossary: [], source: "Second document." },
];

function memoryContent() {
  const store = new Map();
  return {
    store,
    tasks: async () => TASKS,
    put: async (t) => { const h = ethers.keccak256(ethers.toUtf8Bytes(t)); store.set(h, t); return h; },
    get: async (h) => store.get(h),
  };
}

async function world() {
  const s = await ethers.getSigners();
  const [founder, W, V1, V2, V3] = s;
  const ai = { w: s[10], v1: s[11], v2: s[12], v3: s[13] };
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 50);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  await work.setCategory(1, "Open-document translation", 500n, 50n, 20, 2, true);
  await work.setDailyBudget(1, 1000); // a self-found trade needs a budget (THIET-KE-LAM-PHAT.md)
  await work.grantLicense(W.address, ai.w.address, 1, ethers.id("w"), ATT, "worker AI");
  await work.grantLicense(V1.address, ai.v1.address, 2, ethers.id("1"), ATT, "verifier 1");
  await work.grantLicense(V2.address, ai.v2.address, 2, ethers.id("2"), ATT, "verifier 2");
  await work.grantLicense(V3.address, ai.v3.address, 2, ethers.id("3"), ATT, "verifier 3");
  const content = memoryContent();
  const loop = (signer, model) => new AgentLoop({ work: new ethers.Contract(work, WORK_ABI, signer), me: signer.address, content, model });
  return { work, agt, W, ai, content, loop };
}

const goodModel = { translate: async (t) => `Bản dịch của ${t.id}: giữ một bản sao lưu.`, review: async () => ({ verdict: "accept", reason: "faithful, glossary term used" }) };
const strictModel = { translate: goodModel.translate, review: async () => ({ verdict: "reject", flaw: "meaning", reason: "the meaning of the second sentence changed" }) };

describe("Sealed AI work loop (tee/box/agent.js)", () => {
  it("worker submits an open task; drawn verifiers review; the worker's owner is paid", async () => {
    const { work, agt, W, ai, content, loop } = await world();
    const worker = loop(ai.w, goodModel);
    const id = await worker.workerStep(await worker.licence());
    const job = await work.jobs(id);
    const ref = parseUri(job.uri);
    expect(ref.task).to.equal("doc-a");
    expect(ref.hash).to.equal(job.result); // on-chain result hash = the published content
    expect(content.store.get(ref.hash)).to.contain("doc-a");
    await mine(3);
    expect(await worker.drawStep()).to.deep.equal([id]);
    for (const v of [ai.v1, ai.v2, ai.v3]) {
      const l = loop(v, goodModel);
      await l.verifierStep(await l.licence()); // only the two drawn AIs actually vote
    }
    expect(await agt.balanceOf(W.address)).to.equal(500n);
    // the next task is the other document: an accepted task is never redone
    const id2 = await worker.workerStep(await worker.licence());
    expect(parseUri((await work.jobs(id2)).uri).task).to.equal("doc-b");
  });

  it("verifiers that find a flaw reject: nothing is minted, and the task opens again", async () => {
    const { work, agt, W, ai, loop } = await world();
    const worker = loop(ai.w, goodModel);
    const id = await worker.workerStep(await worker.licence());
    await mine(3);
    await worker.drawStep();
    for (const v of [ai.v1, ai.v2, ai.v3]) { const l = loop(v, strictModel); await l.verifierStep(await l.licence()); }
    expect(Number((await work.jobs(id)).status)).to.equal(5); // Rejected
    expect(await agt.balanceOf(W.address)).to.equal(0n);
    const again = await worker.workerStep(await worker.licence());
    expect(parseUri((await work.jobs(again)).uri).task).to.equal("doc-a");
  });

  it("a result whose content does not match its on-chain hash is rejected without asking the model", async () => {
    const { work, ai, content, loop } = await world();
    const w = new ethers.Contract(work, WORK_ABI, ai.w);
    const real = await content.put("honest text");
    await (await w.submitSelf(1, 1, ethers.id("other"), `agt-content://${real}#task=doc-a`)).wait();
    await mine(3);
    await loop(ai.w, goodModel).drawStep();
    let asked = false;
    const spy = { review: async () => { asked = true; return { verdict: "accept", reason: "x" }; } };
    for (const v of [ai.v1, ai.v2, ai.v3]) { const l = loop(v, spy); await l.verifierStep(await l.licence()); }
    expect(asked).to.equal(false);
    expect(Number((await work.jobs(1)).status)).to.equal(5);
  });
});
