// Jobs that people assign, end to end with the sealed AI's loop: the client locks AGT in escrow with the
// hash of the request, publishes the text, the worker AI does it and submits; the client accepts, or
// disputes and AI reviewers of other owners judge; a declined job goes back to the client after the deadline.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { AgentLoop, WORK_ABI } = require("../tee/box/agent.js");

const ATT = ethers.id("sealed-box");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const REQUEST = "Write a two-line Vietnamese summary of: 'Keep a backup of your keys.'";

function memoryContent() {
  const store = new Map();
  return {
    store,
    tasks: async () => [],
    put: async (t) => { const h = ethers.keccak256(ethers.toUtf8Bytes(t)); store.set(h, t); return h; },
    get: async (h) => { if (!store.has(h)) throw new Error("content not found"); return store.get(h); },
  };
}

async function world() {
  const s = await ethers.getSigners();
  const [founder, client, W, V1, V2, V3] = s;
  const ai = { w: s[10], v1: s[11], v2: s[12], v3: s[13] };
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
  await work.setDisputeRules(2, 10n, 3 * DAY);
  await work.grantLicense(W.address, ai.w.address, 1, ethers.id("w"), ATT, "worker AI"); // licence 1
  await work.grantLicense(V1.address, ai.v1.address, 2, ethers.id("1"), ATT, "verifier 1");
  await work.grantLicense(V2.address, ai.v2.address, 2, ethers.id("2"), ATT, "verifier 2");
  await work.grantLicense(V3.address, ai.v3.address, 2, ethers.id("3"), ATT, "verifier 3");
  await vault.connect(client).depositBNB(client.address, { value: E(10) }); // 1.5 AGT
  const content = memoryContent();
  const loop = (signer, model) => new AgentLoop({ work: new ethers.Contract(work, WORK_ABI, signer), me: signer.address, content, model });

  // The client's side, as the /jobs page does it: escrow + spec hash on chain, then the text in the store.
  async function assign(amount = E(1), days = 2) {
    const spec = ethers.keccak256(ethers.toUtf8Bytes(REQUEST));
    await agt.connect(client).approve(work, amount);
    await work.connect(client).assign(1, amount, spec, (await time.latest()) + days * DAY);
    content.store.set(spec, REQUEST);
    return Number(await work.nextJob()) - 1;
  }
  return { work, agt, client, W, V1, ai, content, loop, assign };
}

const doer = { fulfil: async (r) => `Tóm tắt: hãy giữ bản sao lưu khoá của bạn.\n(${r.length} chars of request read)`, judge: async () => ({ verdict: "accept", reason: "fulfils the request" }) };
const refuser = { fulfil: async () => null };
const strict = { judge: async () => ({ verdict: "reject", flaw: "incomplete", reason: "only one line, two were asked" }) };

describe("Jobs people assign — the sealed AI's side (tee/box/agent.js)", () => {
  it("worker AI reads the request, does it, submits; the client accepts and the worker's owner is paid", async () => {
    const { work, agt, client, W, ai, content, loop, assign } = await world();
    const id = await assign();
    const worker = loop(ai.w, doer);
    expect(await worker.assignedStep(await worker.licence())).to.deep.equal([id]);
    const j = await work.jobs(id);
    expect(Number(j.status)).to.equal(2); // Submitted
    expect(j.uri).to.equal(`agt-content://${j.result}#job=${id}`);
    expect(content.store.get(j.result)).to.contain("Tóm tắt");
    await work.connect(client).accept(id);
    expect(await agt.balanceOf(W.address)).to.equal(E(1));
    expect(await worker.assignedStep(await worker.licence())).to.deep.equal([]); // nothing left to do
  });

  it("disputed: reviewer AIs of other owners judge — accepted pays the worker, rejected refunds the client", async () => {
    for (const [model, workerPaid] of [[doer, true], [strict, false]]) {
      const { work, agt, client, W, ai, loop, assign } = await world();
      const id = await assign();
      const worker = loop(ai.w, doer);
      await worker.assignedStep(await worker.licence());
      await work.connect(client).dispute(id);
      const before = await agt.balanceOf(client.address);
      await mine(3);
      expect(await worker.drawStep()).to.deep.equal([id]); // reviewers are drawn, not self-selected
      for (const v of [ai.v1, ai.v2, ai.v3]) { const l = loop(v, model); await l.disputeStep(await l.licence()); }
      expect(Number((await work.jobs(id)).status)).to.equal(workerPaid ? 4 : 6); // Accepted : Refunded
      expect(await agt.balanceOf(W.address)).to.equal(workerPaid ? E(1) : 0n);
      expect(await agt.balanceOf(client.address)).to.equal(workerPaid ? before : before + E(1));
    }
  });

  it("an AI that declines submits nothing; after the deadline the client takes the escrow back", async () => {
    const { work, agt, client, ai, loop, assign } = await world();
    const before = await agt.balanceOf(client.address);
    const id = await assign();
    const worker = loop(ai.w, refuser);
    expect(await worker.assignedStep(await worker.licence())).to.deep.equal([]);
    expect(Number((await work.jobs(id)).status)).to.equal(1); // still Open
    await time.increase(2 * DAY + 1);
    await work.connect(client).reclaim(id);
    expect(await agt.balanceOf(client.address)).to.equal(before);
  });

  it("waits while the client has not published the request text; never works on a request it cannot read", async () => {
    const { work, ai, content, loop, assign } = await world();
    const id = await assign();
    content.store.delete((await work.jobs(id)).spec);
    const worker = loop(ai.w, doer);
    expect(await worker.assignedStep(await worker.licence())).to.deep.equal([]);
  });

  it("a reviewer AI owned by the worker's owner never judges that dispute", async () => {
    const { work, client, W, ai, loop, assign } = await world();
    const id = await assign();
    const worker = loop(ai.w, doer);
    await worker.assignedStep(await worker.licence());
    await work.connect(client).dispute(id);
    // give the worker's owner a reviewer AI too
    const s = await ethers.getSigners();
    await work.grantLicense(W.address, s[14].address, 2, ethers.id("wv"), ATT, "worker owner's reviewer");
    const own = loop(s[14], doer);
    expect(await own.disputeStep(await own.licence())).to.deep.equal([]);
  });
});
