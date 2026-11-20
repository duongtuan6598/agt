// Audit F-9: reviewers of a disputed job are drawn at random (like self-found jobs), a lapsed round gets a
// fresh seed block instead of being cancelled, and a dispute that cannot be decided is settled after 14 days.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { drawFor } = require("./helpers");

const ATT = ethers.id("sealed-box");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const R = "compared the request with the result";

async function world(nVerifiers = 5) {
  const s = await ethers.getSigners();
  const [founder, client, W] = s;
  const owners = s.slice(3, 3 + nVerifiers);
  const ais = s.slice(10, 10 + nVerifiers);
  const wAI = s[19];
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
  await work.setCategory(1, "translation", 500n, 50n, 20, 2, true);
  await work.setDisputeRules(3, 0n, 3 * DAY);
  await work.grantLicense(W.address, wAI.address, 1, ethers.id("w"), ATT, "worker"); // licence 1
  for (let i = 0; i < nVerifiers; i++) await work.grantLicense(owners[i].address, ais[i].address, 2, ethers.id("v" + i), ATT, "v" + i); // 2..
  await vault.connect(client).depositBNB(client.address, { value: E(10) });
  const aiOf = (lic) => ais[lic - 2];
  async function disputed() {
    await agt.connect(client).approve(work, E(1));
    await work.connect(client).assign(1, E(1), ethers.id("request"), (await time.latest()) + 2 * DAY);
    const id = Number(await work.nextJob()) - 1;
    await work.connect(wAI).submitAssigned(id, ethers.id("result"), "agt-content://x");
    await work.connect(client).dispute(id);
    return id;
  }
  return { work, agt, client, W, wAI, ais, aiOf, disputed };
}

describe("Disputes are judged by drawn reviewers (audit F-9)", () => {
  it("draws 2·threshold − 1 reviewers so one side always reaches the threshold; others cannot vote", async () => {
    const { work, agt, client, aiOf, disputed } = await world(6);
    const id = await disputed();
    const drawn = await drawFor(work, id);
    expect(drawn.length).to.equal(5);
    const outsider = [2, 3, 4, 5, 6, 7].find((l) => !drawn.includes(l));
    await expect(work.connect(aiOf(outsider)).vote(id, outsider, true, R)).to.be.revertedWithCustomError(work, "NotAllowed");
    const before = await agt.balanceOf(client.address);
    await work.connect(aiOf(drawn[0])).vote(id, drawn[0], true, R);
    for (const l of drawn.slice(1, 4)) await work.connect(aiOf(l)).vote(id, l, false, R);
    expect(Number((await work.jobs(id)).status)).to.equal(6); // Refunded at 3 "no"
    expect(await agt.balanceOf(client.address)).to.equal(before + E(1));
  });

  it("a split vote with no reviewers left is settled after 14 days: majority wins, a tie splits the escrow", async () => {
    const { work, agt, client, W, aiOf, disputed } = await world(2);
    const id = await disputed();
    const drawn = await drawFor(work, id); // only 2 owners besides the worker: both drawn
    expect(drawn.length).to.equal(2);
    await work.connect(aiOf(drawn[0])).vote(id, drawn[0], true, R);
    await work.connect(aiOf(drawn[1])).vote(id, drawn[1], false, R);
    await expect(work.settleDispute(id)).to.be.revertedWithCustomError(work, "TooEarly");
    await time.increase(14 * DAY + 1);
    const before = await agt.balanceOf(client.address);
    await work.settleDispute(id);
    expect(await agt.balanceOf(W.address)).to.equal(E(0.5));
    expect(await agt.balanceOf(client.address)).to.equal(before + E(0.5));
    await expect(work.settleDispute(id)).to.be.revertedWithCustomError(work, "BadState");
  });

  it("a dispute nobody drew in time is not cancelled: it waits and is settled by time (0–0 splits)", async () => {
    const { work, agt, W, disputed } = await world(5);
    const id = await disputed();
    await mine(300); // seed block now older than 256 blocks
    await work.drawReviewers(id);
    expect(Number((await work.jobs(id)).status)).to.equal(3); // still Disputed, escrow still held
    await expect(work.drawReviewers(id)).to.be.revertedWithCustomError(work, "BadState");
    await time.increase(14 * DAY + 1);
    await work.settleDispute(id);
    expect(await agt.balanceOf(W.address)).to.equal(E(0.5));
  });

  it("a lapsed round gets a fresh seed block and new reviewers — the job is not cancelled (fix)", async () => {
    const { work, wAI, aiOf } = await world(5);
    await work.connect(wAI).submitSelf(1, 1, ethers.id("translation"), "");
    const id = Number(await work.nextJob()) - 1;
    const first = await drawFor(work, id);
    await work.connect(aiOf(first[0])).vote(id, first[0], true, R); // one vote; the other drawn AI is silent
    await time.increase(2 * DAY + 1);
    await mine(300);
    await work.drawReviewers(id); // schedules a fresh seed
    expect(Number((await work.jobs(id)).status)).to.equal(2); // still Submitted, not Rejected
    const second = await drawFor(work, id);
    expect(second.length).to.equal(1); // one more approval needed
    expect(second[0]).to.not.equal(first[0]);
    await work.connect(aiOf(second[0])).vote(id, second[0], true, R);
    expect(Number((await work.jobs(id)).status)).to.equal(4); // Accepted
  });
});
