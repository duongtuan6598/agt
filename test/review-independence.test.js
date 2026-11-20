// Audit finding (20 Nov 2026): approvals were counted per verifier LICENCE, so one owner holding two
// verifier AIs could approve a job alone (translation needs 2 approvals) and be paid twice.
// Rule now: one owner = one vote per job, whatever number of AIs they hold.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { drawFor } = require("./helpers");

const ATT = ethers.id("sealed-box");
const H = (s) => ethers.id(s);

async function deploy() {
  const s = await ethers.getSigners();
  const [founder, W, V, V2] = s;
  const ag = { w: s[10], v1: s[11], v2: s[12], v3: s[13] };
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 10);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  const HAT = await agt.HAT();
  await work.setCategory(1, "Translation", 500n * HAT, 50n * HAT, 20, 2, true); // needs 2 approvals
  await work.grantLicense(W.address, ag.w.address, 1, H("w"), ATT, "worker");
  await work.grantLicense(V.address, ag.v1.address, 2, H("v1"), ATT, "verifier 1 of owner V");
  await work.grantLicense(V.address, ag.v2.address, 2, H("v2"), ATT, "verifier 2 of owner V"); // same owner
  await work.grantLicense(V2.address, ag.v3.address, 2, H("v3"), ATT, "verifier of owner V2");
  await work.connect(ag.w).submitSelf(1, 1, H("job"), "ipfs://job");
  return { work, agt, W, V, V2, ag, HAT };
}

describe("Review independence: one owner, one vote per job", () => {
  it("an owner's second AI cannot add a second approval", async () => {
    const { work, agt, W, ag } = await deploy();
    const drawn = await drawFor(work, 1);
    const vLic = drawn.find((l) => l === 2 || l === 3); // the draw holds one AI of owner V, never both
    expect(drawn.filter((l) => l === 2 || l === 3).length).to.equal(1);
    const [mine, other] = vLic === 2 ? [ag.v1, ag.v2] : [ag.v2, ag.v1];
    await work.connect(mine).vote(1, vLic, true, "faithful translation, glossary respected");
    await expect(work.connect(other).vote(1, vLic === 2 ? 3 : 2, true, "agree with my colleague")).to.be.revertedWithCustomError(work, "AlreadyVoted");
    expect(await agt.balanceOf(W.address)).to.equal(0n); // not minted on one owner's word
  });

  it("two different owners are needed — then the worker is paid and each owner once", async () => {
    const { work, agt, W, V, V2, ag, HAT } = await deploy();
    const by = { 2: ag.v1, 3: ag.v2, 4: ag.v3 };
    for (const lic of await drawFor(work, 1)) await work.connect(by[lic]).vote(1, lic, true, "checked independently against the source");
    expect(await agt.balanceOf(W.address)).to.equal(500n * HAT);
    expect(await agt.balanceOf(V.address)).to.equal(50n * HAT);
    expect(await agt.balanceOf(V2.address)).to.equal(50n * HAT);
  });
});
