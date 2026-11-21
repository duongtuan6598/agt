// Audit F-2: reviewers of self-found jobs are drawn at random, so colluding owners cannot choose each
// other's jobs. The seed is the hash of a block fixed at submission; only drawn AIs may vote.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const { drawFor } = require("./helpers");

const ATT = ethers.id("sealed-box");
const H = (s) => ethers.id(s);
const WHY = "checked against the source and the glossary";

async function deploy(nVerifierOwners = 5) {
  const s = await ethers.getSigners();
  const founder = s[0], W = s[1];
  const owners = s.slice(2, 2 + nVerifierOwners);
  const agents = s.slice(10, 10 + nVerifierOwners);
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 50);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  await work.setCategory(1, "Translation", 1000n, 10n, 50, 2, true);
  await work.setDailyBudget(1, 1000); // a self-found trade needs a budget (THIET-KE-LAM-PHAT.md)
  const wAgent = s[9];
  await work.grantLicense(W.address, wAgent.address, 1, H("w"), ATT, "worker"); // licence 1
  const lic = {}; // licence id -> { agent, owner }
  for (let i = 0; i < nVerifierOwners; i++) {
    await work.grantLicense(owners[i].address, agents[i].address, 2, H("v" + i), ATT, "verifier " + i);
    lic[i + 2] = { agent: agents[i], owner: owners[i] };
  }
  const submit = async () => {
    await work.connect(wAgent).submitSelf(1, 1, H("job" + Math.random()), "");
    return (await work.nextJob()) - 1n;
  };
  return { work, agt, W, wAgent, lic, submit, s };
}

describe("Random reviewer draw (audit F-2)", () => {
  it("nobody may vote before the draw, and the draw needs a later block", async () => {
    const { work, lic, submit } = await deploy();
    const id = await submit();
    await expect(work.connect(lic[2].agent).vote(id, 2, true, WHY)).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.drawReviewers(id)).to.be.revertedWithCustomError(work, "TooEarly");
  });

  it("draws the needed number of AIs of distinct owners; only they may vote", async () => {
    const { work, agt, W, lic, submit } = await deploy(5);
    const id = await submit();
    const drawn = await drawFor(work, id);
    expect(drawn.length).to.equal(2);
    expect(new Set(drawn.map((l) => lic[l].owner.address)).size).to.equal(2);
    const outsider = Object.keys(lic).map(Number).find((l) => !drawn.includes(l));
    await expect(work.connect(lic[outsider].agent).vote(id, outsider, true, WHY)).to.be.revertedWithCustomError(work, "NotAllowed");
    for (const l of drawn) await work.connect(lic[l].agent).vote(id, l, true, WHY);
    expect(await agt.balanceOf(W.address)).to.equal(1000n);
  });

  it("never draws an AI belonging to the worker's own owner", async () => {
    const { work, W, s, submit } = await deploy(2);
    // the worker's owner also holds a verifier AI
    await work.grantLicense(W.address, s[18].address, 2, H("wv"), ATT, "worker owner's verifier");
    for (let i = 0; i < 8; i++) {
      const id = await submit();
      const drawn = await drawFor(work, id);
      expect(drawn).to.not.include(Number(await work.nextLicense()) - 1);
    }
  });

  it("different jobs get different reviewers (the choice is not fixed)", async () => {
    const { work, submit } = await deploy(6);
    const seen = new Set();
    for (let i = 0; i < 10; i++) seen.add((await drawFor(work, await submit())).sort().join(","));
    expect(seen.size).to.be.greaterThan(2);
  });

  it("too few independent owners: the draw refuses instead of picking the same owner twice", async () => {
    const { work, submit } = await deploy(1); // needs 2 approvals, only 1 verifier owner
    const id = await submit();
    await mine(3);
    await expect(work.drawReviewers(id)).to.be.revertedWithCustomError(work, "NotEnoughReviewers");
  });

  it("drawn reviewers who stay silent lose their seat after the review window; votes already cast stay", async () => {
    const { work, agt, W, lic, submit } = await deploy(5);
    const id = await submit();
    const [first, silent] = await drawFor(work, id);
    await work.connect(lic[first].agent).vote(id, first, true, WHY);
    await expect(work.drawReviewers(id)).to.be.revertedWithCustomError(work, "TooEarly");
    await time.increase(2 * 86400 + 1);
    await work.drawReviewers(id); // a lapsed round first schedules a fresh seed block (the old one may be > 256 blocks old)
    const again = await drawFor(work, id);
    expect(again.length).to.equal(1); // one approval still missing
    expect(lic[again[0]].owner.address).to.not.equal(lic[first].owner.address);
    if (again[0] !== silent) await expect(work.connect(lic[silent].agent).vote(id, silent, true, WHY)).to.be.revertedWithCustomError(work, "NotAllowed");
    await work.connect(lic[again[0]].agent).vote(id, again[0], true, WHY);
    expect(await agt.balanceOf(W.address)).to.equal(1000n);
  });

  it("a revoked verifier leaves the pool", async () => {
    const { work, submit } = await deploy(3);
    await work.revokeLicense(3);
    for (let i = 0; i < 6; i++) expect(await drawFor(work, await submit())).to.not.include(3);
    expect((await work.verifierList(0)) !== 3n && (await work.verifierList(1)) !== 3n).to.equal(true);
  });
});

describe("Draw grinding (audit F-2, Slither weak-prng)", () => {
  it("a worker who waits until the seed block hash expires, hoping for a better draw, loses the job", async () => {
    const { work, lic, submit } = await deploy(5);
    const id = await submit();
    await mine(300); // > 256 blocks: the seed block hash is no longer available
    await expect(work.drawReviewers(id)).to.emit(work, "DrawExpired");
    expect((await work.jobs(id)).status).to.equal(5); // Rejected
    await expect(work.drawReviewers(id)).to.be.revertedWithCustomError(work, "BadState");
    await expect(work.connect(lic[2].agent).vote(id, 2, true, WHY)).to.be.revertedWithCustomError(work, "BadState");
  });
});
