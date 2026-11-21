// Charter Article 14 §5 — the emergency brake: AI Council (> 2/3) + owners (> 1/2) may stop NEW deposits
// or NEW work for exactly 14 days; it reopens by itself, cannot be extended, has a 7-day cooldown,
// and never touches funds or work already in progress.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ATT = ethers.id("sealed-box");
const DAY = 86400;
const E = (n) => ethers.parseEther(String(n));
const VAULT = 1;
const WORK = 2;
const R = "exploit seen in tx 0xabc: deposits mint too much";

async function world({ endGenesis = true } = {}) {
  const s = await ethers.getSigners();
  const [founder, client] = s;
  const owners = s.slice(2, 5);
  const ais = s.slice(10, 13);
  const workerAI = s[15];
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const bnb = await Feed.deploy(8, 600n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  await oracle.setFeed(ethers.ZeroAddress, bnb, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, endGenesis ? 3 : 50);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  await vault.setAsset(ethers.ZeroAddress, true);
  const brake = await (await ethers.getContractFactory("EmergencyBrake")).deploy(work);
  await vault.setBrake(brake);
  await work.setBrake(brake); // before genesis ends: afterwards Work has no owner at all
  await work.setCategory(1, "translation", E(1), E(0.1), 10, 1, true);
  await work.setDailyBudget(1, 1000); // a self-found trade needs a budget (THIET-KE-LAM-PHAT.md)
  await work.grantLicense(owners[0].address, workerAI.address, 1, ethers.id("w"), ethers.ZeroHash, "worker"); // licence 1
  for (let i = 0; i < 3; i++) await work.grantLicense(owners[i].address, ais[i].address, 2, ethers.id("v" + i), ATT, "verifier " + i); // 2..4
  return { s, founder, client, owners, ais, workerAI, vault, work, agt, brake, xau, bnb };
}

async function pull(brake, ais, owners, target) {
  await brake.connect(ais[0]).request(2, target, R);
  await brake.connect(ais[1]).aiVote(1, 3, R); // 2 of 3 is not > 2/3
  await brake.connect(ais[2]).aiVote(1, 4, R);
  await brake.connect(owners[0]).humanSign(1);
  await brake.connect(owners[1]).humanSign(1); // 2 of 3 > 1/2 → applied
}

describe("EmergencyBrake — Article 14 §5", () => {
  it("both keys close the Vault to new deposits for exactly 14 days, then it reopens by itself", async () => {
    const { client, owners, ais, vault, brake, xau, bnb } = await world();
    await vault.connect(client).depositBNB(client.address, { value: E(1) });
    await pull(brake, ais, owners, VAULT);
    expect(await brake.paused(VAULT)).to.equal(true);
    expect(await brake.paused(WORK)).to.equal(false);
    await expect(vault.connect(client).depositBNB(client.address, { value: E(1) })).to.be.revertedWithCustomError(vault, "Braked");
    await time.increase(14 * DAY);
    expect(await brake.paused(VAULT)).to.equal(false);
    await xau.set(4000n * 10n ** 8n); // fresh prices after two weeks
    await bnb.set(600n * 10n ** 8n);
    await expect(vault.connect(client).depositBNB(client.address, { value: E(1) })).to.not.be.reverted;
  });

  it("AI votes alone, or humans alone, do nothing", async () => {
    const { owners, ais, brake } = await world();
    await brake.connect(ais[0]).request(2, VAULT, R);
    await brake.connect(ais[1]).aiVote(1, 3, R);
    await expect(brake.connect(owners[0]).humanSign(1)).to.be.revertedWithCustomError(brake, "NotPassed"); // AI not yet > 2/3
    await brake.connect(ais[2]).aiVote(1, 4, R);
    await brake.connect(owners[0]).humanSign(1);
    expect(await brake.paused(VAULT)).to.equal(false); // 1 of 3 owners
    await time.increase(3 * DAY);
    await expect(brake.connect(owners[1]).humanSign(1)).to.be.revertedWithCustomError(brake, "TooLate");
    expect(await brake.paused(VAULT)).to.equal(false);
  });

  it("two separate keys: owner wallets cannot vote as AIs, AI keys cannot sign as owners", async () => {
    const { owners, ais, brake } = await world();
    await expect(brake.connect(owners[0]).request(2, VAULT, R)).to.be.revertedWithCustomError(brake, "NotSealedAI");
    await brake.connect(ais[0]).request(2, VAULT, R);
    await expect(brake.connect(ais[0]).aiVote(1, 2, R)).to.be.revertedWithCustomError(brake, "Already");
    await brake.connect(ais[1]).aiVote(1, 3, R);
    await brake.connect(ais[2]).aiVote(1, 4, R);
    await expect(brake.connect(ais[0]).humanSign(1)).to.be.revertedWithCustomError(brake, "NotOwner");
  });

  it("cannot be extended or chained: no new brake on the same target until 7 days after it ends", async () => {
    const { owners, ais, brake } = await world();
    await pull(brake, ais, owners, VAULT);
    await expect(brake.connect(ais[0]).request(2, VAULT, R)).to.be.revertedWithCustomError(brake, "Cooldown");
    await time.increase(14 * DAY);
    await expect(brake.connect(ais[0]).request(2, VAULT, R)).to.be.revertedWithCustomError(brake, "Cooldown");
    await time.increase(7 * DAY);
    await expect(brake.connect(ais[0]).request(2, VAULT, R)).to.not.be.reverted;
  });

  it("braking work stops new jobs only; work in progress is still reviewed, and escrow can still be refunded", async () => {
    const { client, owners, ais, workerAI, vault, work, agt, brake } = await world();
    await vault.connect(client).depositBNB(client.address, { value: E(10) }); // 1.5 AGT
    await agt.connect(client).approve(work, E(10));
    const dl = (await time.latest()) + 3 * DAY;
    await work.connect(client).assign(1, E(1), ethers.id("spec"), dl); // job 1, before the brake
    await pull(brake, ais, owners, WORK);
    await expect(work.connect(workerAI).submitSelf(1, 1, ethers.id("r"), "")).to.be.revertedWithCustomError(work, "Braked");
    await expect(work.connect(client).assign(1, E(1), ethers.id("spec2"), dl)).to.be.revertedWithCustomError(work, "Braked");
    await expect(work.connect(workerAI).submitAssigned(1, ethers.id("result"), "ipfs://r")).to.not.be.reverted;
    await expect(work.connect(client).accept(1)).to.not.be.reverted;
  });

  it("closed during genesis; it has no other power than answering 'paused?'", async () => {
    const { ais, brake } = await world({ endGenesis: false });
    await expect(brake.connect(ais[0]).request(2, VAULT, R)).to.be.revertedWithCustomError(brake, "Closed");
    const writes = brake.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name).sort();
    expect(writes).to.deep.equal(["aiVote", "humanSign", "request"]);
  });

  it("the brake is attached once and can never be swapped", async () => {
    const { founder, vault, work } = await world();
    await expect(vault.connect(founder).setBrake(founder.address)).to.be.revertedWithCustomError(vault, "AlreadyBound");
    await expect(work.connect(founder).setBrake(founder.address)).to.be.reverted; // Work has no owner after genesis
  });
});
