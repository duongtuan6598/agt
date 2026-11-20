// Long-term work (THIET-KE-NGHE-NHUNG.md): Engagement (milestones, revisions, hardware test, warranty holdback,
// drawn-reviewer disputes) and Maintenance (monthly retainer with on-chain service levels).
// Every scenario ends by checking that no AGT is left stuck in the contract.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const ATT = ethers.id("sealed-box");
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const H = (s) => ethers.id(s);
const R = "checked the delivery against the brief's acceptance criteria";

async function world() {
  const s = await ethers.getSigners();
  const [founder, client, W, stranger] = s;
  const vOwners = s.slice(4, 9);
  const vAIs = s.slice(10, 15);
  const wAI = s[15];
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
  await work.grantLicense(W.address, wAI.address, 1, H("w"), ATT, "embedded worker"); // licence 1
  for (let i = 0; i < 5; i++) await work.grantLicense(vOwners[i].address, vAIs[i].address, 2, H("v" + i), ATT, "reviewer " + i); // 2..6
  await vault.connect(client).depositBNB(client.address, { value: E(20) }); // 3 AGT
  const eng = await (await ethers.getContractFactory("Engagement")).deploy(work);
  const mnt = await (await ethers.getContractFactory("Maintenance")).deploy(work);
  await agt.connect(client).approve(eng, E(100));
  await agt.connect(client).approve(mnt, E(100));
  const aiOf = (lic) => vAIs[lic - 2];
  const plan = (amounts, hw, days = amounts.map(() => 30), holdbackBps = 2000, warrantyDays = 90) => ({ amounts, hwBps: hw, dueDays: days, holdbackBps, warrantyDays });
  async function opened(p = plan([E(1), E(1)], [0, 3000])) {
    await eng.connect(client).open(1, H("brief"), p);
    const id = Number(await eng.nextEngagement()) - 1;
    await eng.connect(wAI).start(id);
    return id;
  }
  async function decide(did, workerRight, votes = 3) {
    await mine(3);
    const rc = await (await eng.drawReviewers(did)).wait();
    const ev = rc.logs.map((l) => { try { return eng.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ReviewersDrawn");
    const lics = ev.args.licences.map(Number);
    for (const l of lics.slice(0, votes)) await eng.connect(aiOf(l)).vote(did, l, workerRight, R);
    return lics;
  }
  const empty = async () => expect(await agt.balanceOf(eng)).to.equal(0n);
  return { work, agt, eng, mnt, client, W, wAI, stranger, vAIs, aiOf, plan, opened, decide, empty, brakeOf: () => work };
}

describe("Engagement — milestones, hardware test, warranty (embedded trade)", () => {
  it("full project: holdback kept, hardware part paid only on the client's confirmation, released after the warranty", async () => {
    const { agt, eng, client, W, wAI, opened, empty } = await world();
    const id = await opened();
    await eng.connect(wAI).deliver(id, 0, H("commit-a"), H("report-a"));
    await eng.connect(client).accept(id, 0);
    expect(await agt.balanceOf(W.address)).to.equal(E(0.8)); // 20% held for the warranty
    await eng.connect(wAI).deliver(id, 1, H("commit-b"), H("report-b"));
    await eng.connect(client).accept(id, 1); // simulation part (70%) only
    expect(await agt.balanceOf(W.address)).to.equal(E(0.8) + E(0.56));
    expect((await eng.milestone(id, 1)).state).to.equal(3n); // HwTesting
    await eng.connect(client).confirmHardware(id, 1);
    expect(await agt.balanceOf(W.address)).to.equal(E(0.8) + E(0.8));
    await expect(eng.releaseHoldback(id, 0)).to.be.revertedWithCustomError(eng, "BadState");
    await time.increase(90 * DAY + 1);
    await eng.releaseHoldback(id, 0);
    await eng.releaseHoldback(id, 1);
    expect(await agt.balanceOf(W.address)).to.equal(E(2));
    const rep = await eng.reputation(1);
    expect(rep.engagements).to.equal(1);
    expect(rep.milestonesDone).to.equal(2);
    await empty();
  });

  it("a silent client: delivery auto-accepted after 7 days; hardware part paid after 28 days only if no failure was ever reported", async () => {
    const { agt, eng, W, wAI, stranger, plan, opened, empty } = await world();
    const id = await opened(plan([E(1)], [3000], [30], 0, 0));
    await eng.connect(wAI).deliver(id, 0, H("c"), H("r"));
    await expect(eng.connect(stranger).autoAccept(id, 0)).to.be.revertedWithCustomError(eng, "BadState");
    await time.increase(7 * DAY + 1);
    await eng.connect(stranger).autoAccept(id, 0);
    expect(await agt.balanceOf(W.address)).to.equal(E(0.7));
    await expect(eng.connect(stranger).hardwareTimeout(id, 0)).to.be.revertedWithCustomError(eng, "BadState");
    await time.increase(28 * DAY + 1);
    await eng.connect(stranger).hardwareTimeout(id, 0);
    expect(await agt.balanceOf(W.address)).to.equal(E(1));
    await empty();
  });

  it("the board fails: revisions first (simulation part never paid twice), then reviewers; the client wins and gets the rest back", async () => {
    const { agt, eng, client, W, wAI, plan, opened, decide, empty } = await world();
    const before = await agt.balanceOf(client.address);
    const id = await opened(plan([E(1)], [5000], [30], 2000, 90));
    for (let i = 0; i < 3; i++) {
      await eng.connect(wAI).deliver(id, 0, H("c" + i), H("r" + i));
      await eng.connect(client).accept(id, 0);
      await eng.connect(client).reportHardwareFailure(id, 0, H("scope-capture-" + i));
    }
    // 2 revisions used, the 3rd failure goes to the reviewers
    expect(await agt.balanceOf(W.address)).to.equal(E(0.4)); // simulation half once, minus 20% holdback
    const m = await eng.milestone(id, 0);
    expect(m.state).to.equal(5n); // Disputed
    await decide(m.dispute, false);
    expect(await agt.balanceOf(W.address)).to.equal(E(0.4));
    expect(await agt.balanceOf(client.address)).to.equal(before - E(0.4)); // hardware half + holdback back to the client
    expect((await eng.reputation(1)).disputesLost).to.equal(1);
    await empty();
  });

  it("a hardware failure was reported once, then the client goes silent: reviewers decide, the money is never stuck", async () => {
    const { eng, client, wAI, stranger, plan, opened, empty, agt, W } = await world();
    const id = await opened(plan([E(1)], [5000], [30], 0, 0));
    await eng.connect(wAI).deliver(id, 0, H("c"), H("r"));
    await eng.connect(client).accept(id, 0);
    await eng.connect(client).reportHardwareFailure(id, 0, H("log"));
    await eng.connect(wAI).deliver(id, 0, H("c2"), H("r2"));
    await eng.connect(client).accept(id, 0);
    await time.increase(28 * DAY + 1);
    await eng.connect(stranger).hardwareTimeout(id, 0); // failure on record → a dispute, not an automatic payment
    const m = await eng.milestone(id, 0);
    expect(m.state).to.equal(5n);
    await time.increase(14 * DAY + 1);
    await eng.settleDispute(m.dispute); // nobody drew, 0–0: split
    expect(await agt.balanceOf(W.address)).to.equal(E(0.5) + E(0.25));
    await empty();
  });

  it("revisions are limited to 2; a disputed delivery decided for the worker pays it", async () => {
    const { agt, eng, client, W, wAI, plan, opened, decide, empty } = await world();
    const id = await opened(plan([E(1)], [0], [30], 0, 0));
    for (let i = 0; i < 2; i++) {
      await eng.connect(wAI).deliver(id, 0, H("c" + i), H("r"));
      await eng.connect(client).requestRevision(id, 0, H("missing timer driver"));
    }
    await eng.connect(wAI).deliver(id, 0, H("c3"), H("r"));
    await expect(eng.connect(client).requestRevision(id, 0, H("again"))).to.be.revertedWithCustomError(eng, "BadState");
    await eng.connect(client).dispute(id, 0);
    await decide((await eng.milestone(id, 0)).dispute, true);
    expect(await agt.balanceOf(W.address)).to.equal(E(1));
    expect((await eng.reputation(1)).revisions).to.equal(2);
    await empty();
  });

  it("warranty: no fix in time refunds the holdback; a fix closes the claim; a contested claim goes to the reviewers", async () => {
    const { agt, eng, client, W, wAI, stranger, plan, opened, decide, empty } = await world();
    const id = await opened(plan([E(1), E(1), E(1)], [0, 0, 0], [30, 30, 30], 2000, 90));
    for (let m = 0; m < 3; m++) {
      await eng.connect(wAI).deliver(id, m, H("c" + m), H("r"));
      await eng.connect(client).accept(id, m);
    }
    const c0 = await agt.balanceOf(client.address);
    // m0: no fix within 14 days → holdback to the client
    await eng.connect(client).claimWarranty(id, 0, H("watchdog resets in the field"));
    await time.increase(14 * DAY + 1);
    await eng.connect(stranger).warrantyTimeout(id, 0);
    expect(await agt.balanceOf(client.address)).to.equal(c0 + E(0.2));
    // m1: fixed, client silent → anyone closes the claim; holdback later released to the worker
    await eng.connect(client).claimWarranty(id, 1, H("uart overrun"));
    await eng.connect(wAI).deliverFix(id, 1, H("fix-commit"));
    await time.increase(14 * DAY + 1);
    await eng.connect(stranger).closeClaim(id, 1);
    // m2: the AI says it is a new requirement → reviewers agree with the client
    await eng.connect(client).claimWarranty(id, 2, H("add BLE support"));
    await eng.connect(wAI).disputeClaim(id, 2);
    await decide((await eng.milestone(id, 2)).dispute, false);
    expect(await agt.balanceOf(client.address)).to.equal(c0 + E(0.4));
    await time.increase(90 * DAY);
    await eng.releaseHoldback(id, 1);
    expect(await agt.balanceOf(W.address)).to.equal(E(2.4) + E(0.2));
    expect((await eng.reputation(1)).warrantyFailed).to.equal(2);
    await empty();
  });

  it("late delivery, cancel before start and ending early all return the money to the client", async () => {
    const { agt, eng, client, wAI, stranger, plan, opened, empty } = await world();
    const before = await agt.balanceOf(client.address);
    await eng.connect(client).open(1, H("b"), plan([E(1)], [0]));
    const c = Number(await eng.nextEngagement()) - 1;
    await expect(eng.connect(stranger).cancel(c)).to.be.revertedWithCustomError(eng, "NotClient");
    await eng.connect(client).cancel(c);
    const id = await opened(plan([E(1), E(1)], [0, 0], [10, 60], 0, 0));
    await time.increase(10 * DAY + 1);
    await expect(eng.connect(wAI).deliver(id, 0, H("late"), H("r"))).to.be.revertedWithCustomError(eng, "BadState");
    await eng.connect(stranger).reclaimLate(id, 0);
    await expect(eng.connect(stranger).end(id)).to.be.revertedWithCustomError(eng, "NotClient");
    await eng.connect(wAI).end(id); // the AI may end it too: undelivered milestones go back
    expect(await agt.balanceOf(client.address)).to.equal(before);
    expect((await eng.reputation(1)).late).to.equal(1);
    await empty();
  });

  it("only the right parties act; no self-dealing; reviewers must be drawn; one dispute at a time", async () => {
    const { eng, client, W, wAI, stranger, vAIs, plan, opened } = await world();
    await expect(eng.connect(W).open(1, H("b"), plan([E(1)], [0]))).to.be.revertedWithCustomError(eng, "BadParams"); // owner hiring own AI
    const id = await opened(plan([E(1)], [0]));
    await expect(eng.connect(stranger).deliver(id, 0, H("c"), H("r"))).to.be.revertedWithCustomError(eng, "NotWorker");
    await eng.connect(wAI).deliver(id, 0, H("c"), H("r"));
    await expect(eng.connect(stranger).accept(id, 0)).to.be.revertedWithCustomError(eng, "NotClient");
    await eng.connect(client).dispute(id, 0);
    const did = (await eng.milestone(id, 0)).dispute;
    await expect(eng.connect(vAIs[0]).vote(did, 2, true, R)).to.be.revertedWithCustomError(eng, "NotDrawn");
    // a drawn panel loses its seat once its round has lapsed (Codex E-1)
    await mine(3);
    const rc = await (await eng.drawReviewers(did)).wait();
    const lic = Number(rc.logs.map((l) => { try { return eng.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ReviewersDrawn").args.licences[0]);
    await time.increase(2 * DAY + 1);
    await expect(eng.connect(vAIs[lic - 2]).vote(did, lic, true, R)).to.be.revertedWithCustomError(eng, "NotDrawn");
    await expect(eng.connect(client).dispute(id, 0)).to.be.revertedWithCustomError(eng, "BadState");
  });
});

describe("Engagement — the worker's claim when the client's CI fails or stays silent (§13)", () => {
  it("the AI may ask reviewers to decide a pending milestone: once, before the deadline; it freezes the client's reclaim", async () => {
    const { agt, eng, client, W, wAI, stranger, plan, opened, decide, empty } = await world();
    const id = await opened(plan([E(1)], [0], [30], 0, 0));
    await expect(eng.connect(stranger).claimDone(id, 0, H("c"), H("ev"))).to.be.revertedWithCustomError(eng, "NotWorker");
    await eng.connect(wAI).claimDone(id, 0, H("commit"), H("evidence: CI silent for 6 h, 3 rounds"));
    await expect(eng.connect(wAI).claimDone(id, 0, H("c2"), H("ev2"))).to.be.revertedWithCustomError(eng, "BadState"); // once
    await time.increase(31 * DAY);
    await expect(eng.connect(stranger).reclaimLate(id, 0)).to.be.revertedWithCustomError(eng, "BadState"); // frozen while reviewers decide
    await decide((await eng.milestone(id, 0)).dispute, true);
    expect(await agt.balanceOf(W.address)).to.equal(E(1));
    expect((await eng.reputation(1)).disputesWon).to.equal(1);
    await empty();
  });

  it("reviewers who find the milestone not done refund the client; a claim after the deadline is refused", async () => {
    const { agt, eng, client, wAI, plan, opened, decide, empty } = await world();
    const before = await agt.balanceOf(client.address);
    const id = await opened(plan([E(1), E(1)], [0, 0], [10, 20], 0, 0));
    await eng.connect(wAI).claimDone(id, 0, H("commit"), H("evidence"));
    await decide((await eng.milestone(id, 0)).dispute, false);
    expect((await eng.reputation(1)).disputesLost).to.equal(1);
    await time.increase(21 * DAY);
    await expect(eng.connect(wAI).claimDone(id, 1, H("late"), H("ev"))).to.be.revertedWithCustomError(eng, "BadState");
    await eng.reclaimLate(id, 1);
    expect(await agt.balanceOf(client.address)).to.equal(before);
    await empty();
  });
});

describe("Maintenance — monthly retainer, service levels measured on chain", () => {
  async function retainer(w, fee = E(1), penaltyBps = 2000) {
    await w.mnt.connect(w.client).open(1, H("maintain firmware v2"), fee, penaltyBps);
    const id = Number(await w.mnt.nextRetainer()) - 1;
    await w.mnt.connect(w.wAI).start(id);
    return id;
  }

  it("incidents answered in time: the month is paid in full", async () => {
    const w = await world();
    const id = await retainer(w);
    await w.mnt.connect(w.client).report(id, 1, H("sensor reads 0 after sleep"));
    await w.mnt.connect(w.wAI).acknowledge(id, 0);
    await w.mnt.connect(w.client).report(id, 2, H("CVE in mbedTLS"));
    await w.mnt.connect(w.wAI).acknowledge(id, 1); // security incidents need the 24 h answer too
    await time.increase(2 * DAY);
    await w.mnt.connect(w.wAI).resolve(id, 1, H("patch commit"));
    await w.mnt.connect(w.wAI).submitStatus(id, 0, H("status: 2 outdated libs, no new CVE, 61 KB flash"));
    await expect(w.mnt.closeMonth(id)).to.be.revertedWithCustomError(w.mnt, "BadState");
    await time.increase(31 * DAY);
    await w.mnt.closeMonth(id);
    expect(await w.agt.balanceOf(w.W.address)).to.equal(E(1));
    expect((await w.mnt.record(1)).monthsServed).to.equal(1);
  });

  it("missed service levels take part of the fee back to the client", async () => {
    const w = await world();
    const before = await w.agt.balanceOf(w.client.address);
    const id = await retainer(w);
    await w.mnt.connect(w.client).report(id, 1, H("crash"));
    await w.mnt.connect(w.client).report(id, 2, H("CVE"));
    await time.increase(DAY + 1);
    await w.mnt.connect(w.wAI).acknowledge(id, 0); // late ack (1 miss)
    await time.increase(4 * DAY);
    await w.mnt.connect(w.wAI).resolve(id, 1, H("late fix")); // late ack + late fix (2 misses)
    await w.mnt.connect(w.wAI).submitStatus(id, 0, H("status"));
    await time.increase(30 * DAY);
    await w.mnt.closeMonth(id);
    expect(await w.agt.balanceOf(w.W.address)).to.equal(E(0.4)); // 3 misses × 20%
    expect(await w.agt.balanceOf(w.client.address)).to.equal(before - E(0.4));
    expect((await w.mnt.record(1)).slaMissed).to.equal(3);
  });

  it("a missing monthly status report counts as a miss; a client cannot flood incidents (Codex E-2, E-4)", async () => {
    const w = await world();
    const id = await retainer(w, E(1), 1000);
    for (let i = 0; i < 8; i++) {
      await w.mnt.connect(w.client).report(id, 1, H("ticket " + i));
      await w.mnt.connect(w.wAI).acknowledge(id, i);
    }
    await expect(w.mnt.connect(w.client).report(id, 1, H("one too many"))).to.be.revertedWithCustomError(w.mnt, "BadState");
    await time.increase(33 * DAY);
    await expect(w.mnt.connect(w.wAI).submitStatus(id, 0, H("too late"))).to.be.revertedWithCustomError(w.mnt, "BadState");
    await w.mnt.closeMonth(id);
    expect(await w.agt.balanceOf(w.W.address)).to.equal(E(0.9)); // only the missing report: 1 miss × 10%
  });

  it("prepay only before the period ends; stopping returns future months; no incidents outside paid months", async () => {
    const w = await world();
    const before = await w.agt.balanceOf(w.client.address);
    const id = await retainer(w);
    await w.mnt.connect(w.client).fund(id);
    await w.mnt.connect(w.client).fund(id); // 3 months paid
    await w.mnt.connect(w.client).stop(id); // month 0 runs; months 1 and 2 come back
    expect(await w.agt.balanceOf(w.client.address)).to.equal(before - E(1));
    await time.increase(30 * DAY);
    await expect(w.mnt.connect(w.client).report(id, 1, H("x"))).to.be.revertedWithCustomError(w.mnt, "BadState");
    await expect(w.mnt.connect(w.client).fund(id)).to.be.revertedWithCustomError(w.mnt, "BadState");
    await time.increase(3 * DAY);
    await w.mnt.closeMonth(id);
    await expect(w.mnt.closeMonth(id)).to.be.revertedWithCustomError(w.mnt, "BadState");
    expect(await w.agt.balanceOf(w.mnt)).to.equal(0n);
  });
});
