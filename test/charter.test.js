// Charter Article 14 on chain: amendments need AI votes (sealed Council AIs) AND human co-signatures
// (owner wallets), with public, voting, signing and waiting periods; Article 14 itself needs more.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ATT = ethers.id("sealed-box");
const DAY = 86400;
const R = "checked against Article 14 §1: no unamendable rule is touched";

async function world(nOwners = 3, { endGenesis = true } = {}) {
  const s = await ethers.getSigners();
  const founder = s[0];
  const owners = s.slice(1, 1 + nOwners);
  const ais = s.slice(10, 10 + nOwners);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, endGenesis ? nOwners : 50);
  for (let i = 0; i < nOwners; i++) await work.grantLicense(owners[i].address, ais[i].address, 2, ethers.id("v" + i), ATT, "verifier " + i);
  const registry = await (await ethers.getContractFactory("CharterRegistry")).deploy(work, ethers.id("charter v0.10"));
  return { s, founder, owners, ais, work, registry };
}

describe("CharterRegistry — Article 14", () => {
  it("during genesis the founder amends only with 7 days' notice; outsiders never", async () => {
    const { founder, s, registry } = await world(2, { endGenesis: false });
    await expect(registry.connect(s[9]).genesisAnnounce(ethers.id("x"))).to.be.revertedWithCustomError(registry, "NotOwner");
    await registry.connect(founder).genesisAnnounce(ethers.id("charter v0.11"));
    await expect(registry.connect(founder).genesisEnact()).to.be.revertedWithCustomError(registry, "TooEarly");
    await time.increase(7 * DAY);
    await registry.connect(founder).genesisEnact();
    expect(await registry.charter()).to.equal(ethers.id("charter v0.11"));
    await expect(registry.propose(1, ethers.id("y"), false, "ipfs://x", R)).to.be.revertedWithCustomError(registry, "Closed");
  });

  it("when genesis ends, the founder's amending power is gone for ever", async () => {
    const { founder, registry } = await world(3);
    await expect(registry.connect(founder).genesisAnnounce(ethers.id("x"))).to.be.revertedWithCustomError(registry, "NotOwner");
  });

  it("full procedure: propose → 30 days → AI > 2/3 → owners > 1/2 → 7 days → in force", async () => {
    const { owners, ais, registry } = await world(3);
    const text = ethers.id("charter v0.11");
    await registry.connect(ais[0]).propose(1, text, false, "ipfs://amendment", R);
    await expect(registry.connect(ais[0]).aiVote(1, 1, true, R)).to.be.revertedWithCustomError(registry, "TooEarly");
    await time.increase(30 * DAY);
    for (let i = 0; i < 3; i++) await registry.connect(ais[i]).aiVote(1, i + 1, true, R);
    expect((await registry.proposals(1)).aiPassedAt).to.be.gt(0n);
    await registry.connect(owners[0]).humanSign(1);
    expect((await registry.proposals(1)).humansPassedAt).to.equal(0n); // 1 of 3 is not > 1/2
    await registry.connect(owners[1]).humanSign(1);
    await expect(registry.enact(1)).to.be.revertedWithCustomError(registry, "TooEarly");
    await time.increase(7 * DAY);
    await registry.enact(1);
    expect(await registry.charter()).to.equal(text);
  });

  it("two separate keys: an AI key cannot co-sign as a human, an owner wallet cannot vote as an AI", async () => {
    const { owners, ais, registry } = await world(3);
    await registry.connect(ais[0]).propose(1, ethers.id("t"), false, "ipfs://a", R);
    await time.increase(30 * DAY);
    await expect(registry.connect(owners[0]).aiVote(1, 1, true, R)).to.be.revertedWithCustomError(registry, "NotSealedAI");
    for (let i = 0; i < 3; i++) await registry.connect(ais[i]).aiVote(1, i + 1, true, R);
    await expect(registry.connect(ais[0]).humanSign(1)).to.be.revertedWithCustomError(registry, "NotOwner");
    await expect(registry.connect(owners[0]).humanSign(1)).to.not.be.reverted;
    await expect(registry.connect(owners[0]).humanSign(1)).to.be.revertedWithCustomError(registry, "Already");
  });

  it("AI vote without humans, or humans too late, changes nothing", async () => {
    const { owners, ais, registry } = await world(3);
    await registry.connect(ais[0]).propose(1, ethers.id("t"), false, "ipfs://a", R);
    await time.increase(30 * DAY);
    for (let i = 0; i < 3; i++) await registry.connect(ais[i]).aiVote(1, i + 1, true, R);
    await time.increase(15 * DAY);
    await expect(registry.connect(owners[0]).humanSign(1)).to.be.revertedWithCustomError(registry, "TooLate");
    await expect(registry.enact(1)).to.be.revertedWithCustomError(registry, "NotPassed");
    expect(await registry.charter()).to.equal(ethers.id("charter v0.10"));
  });

  it("amending Article 14 needs 60 days, AI > 3/4 and owners > 2/3", async () => {
    const { owners, ais, registry } = await world(4);
    await registry.connect(ais[0]).propose(1, ethers.id("art14 change"), true, "ipfs://a", R);
    await time.increase(30 * DAY);
    await expect(registry.connect(ais[0]).aiVote(1, 1, true, R)).to.be.revertedWithCustomError(registry, "TooEarly");
    await time.increase(30 * DAY);
    for (let i = 0; i < 3; i++) await registry.connect(ais[i]).aiVote(1, i + 1, true, R);
    expect((await registry.proposals(1)).aiPassedAt).to.equal(0n); // 3 of 4 is not > 3/4
    await registry.connect(ais[3]).aiVote(1, 4, true, R);
    for (let i = 0; i < 2; i++) await registry.connect(owners[i]).humanSign(1);
    expect((await registry.proposals(1)).humansPassedAt).to.equal(0n); // 2 of 4 is not > 2/3
    await registry.connect(owners[2]).humanSign(1);
    await time.increase(7 * DAY);
    await registry.enact(1);
    expect(await registry.charter()).to.equal(ethers.id("art14 change"));
  });

  it("the registry holds no power over AGT, the Vault or Work: it only records a hash", async () => {
    const { registry } = await world(3);
    const writes = registry.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name).sort();
    expect(writes).to.deep.equal(["aiVote", "enact", "genesisAnnounce", "genesisEnact", "humanSign", "propose"]);
  });
});
