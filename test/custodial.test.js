// Custodial assets in the Vault (tokenized gold held by a custodian or nation, fiat stablecoins):
// <= 5% per token and <= 10% per custodian group of all Vault-minted AGT (docs/decisions/2026-11-22-custodial-assets.md).
const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [owner, user, work] = await ethers.getSigners();
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oz = await Feed.deploy(8, 4000n * 10n ** 8n); // 1 token = 1 oz of gold = 1 AGT
  const Token = await ethers.getContractFactory("MockToken");
  const base = await Token.deploy("BASE", 18); // a non-custodial asset
  const goldA = await Token.deploy("GOLD-A", 18); // custodian 1
  const goldA2 = await Token.deploy("GOLD-A2", 18); // custodian 1, another wrapper
  const goldA3 = await Token.deploy("GOLD-A3", 18); // custodian 1, a third wrapper
  const goldB = await Token.deploy("GOLD-B", 18); // custodian 2
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(owner.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(owner.address, oracle);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work.address);
  await vault.bind(agt);
  for (const t of [base, goldA, goldA2, goldA3, goldB]) {
    await oracle.setFeed(t, oz, 3600);
    await vault.setAsset(t, true);
    await t.mint(user.address, E(1000));
    await t.connect(user).approve(vault, E(1000));
  }
  await vault.setCustodial(goldA, 1);
  await vault.setCustodial(goldA2, 1);
  await vault.setCustodial(goldA3, 1);
  await vault.setCustodial(goldB, 2);
  const dep = (t, n) => vault.connect(user).deposit(t, E(n), user.address);
  return { owner, user, vault, agt, base, goldA, goldA2, goldA3, goldB, dep };
}

describe("Vault: custodial assets", () => {
  it("an empty Vault takes no custodial gold; non-custodial assets come in freely", async () => {
    const { vault, base, goldA, dep } = await deploy();
    await expect(dep(goldA, 1)).to.be.revertedWithCustomError(vault, "Concentrated");
    await dep(base, 95);
    expect(await vault.mintedTotal()).to.equal(E(95));
  });

  it("one custodial token fits up to 5% of the Vault, not a grain more", async () => {
    const { vault, base, goldA, dep } = await deploy();
    await dep(base, 95);
    await dep(goldA, 5); // 5 / 100
    await expect(dep(goldA, 0.01)).to.be.revertedWithCustomError(vault, "Concentrated");
  });

  it("tokens of the same custodian count together: <= 10%; another custodian has its own room", async () => {
    const { vault, base, goldA, goldA2, goldA3, goldB, dep } = await deploy();
    await dep(base, 380);
    await dep(goldA, 20); // 20 / 400 = 5%
    await dep(goldA2, 20); // group 1: 40 / 420
    await dep(goldA3, 2); // group 1: 42 / 422 < 10%, token 0.5%
    await expect(dep(goldA3, 1)).to.be.revertedWithCustomError(vault, "Concentrated"); // group 43 / 423 > 10%
    await dep(goldB, 20); // group 2 has its own room
    expect(await vault.mintedForGroup(1)).to.equal(E(42));
  });

  it("marking custodial is one-way, counts past deposits, and works even when the Vault is frozen", async () => {
    const { vault, base, dep, goldB } = await deploy();
    await dep(base, 100);
    await expect(vault.setCustodial(goldB, 3)).to.be.revertedWithCustomError(vault, "AlreadyCustodial");
    await expect(vault.setCustodial(base, 0)).to.be.revertedWithCustomError(vault, "BadGroup");
    await vault.freeze();
    await expect(vault.setCustodial(base, 9)).to.emit(vault, "OverLimitWhenMarked"); // stricter only: allowed after freeze
    expect(await vault.mintedForGroup(9)).to.equal(E(100));
    await expect(dep(base, 1)).to.be.revertedWithCustomError(vault, "Concentrated"); // base is now 100% of the Vault
  });

  it("only the owner classifies, and the limits are constants", async () => {
    const { vault, user, base } = await deploy();
    await expect(vault.connect(user).setCustodial(base, 1)).to.be.reverted;
    expect(await vault.TOKEN_BPS()).to.equal(500n);
    expect(await vault.GROUP_BPS()).to.equal(1000n);
  });
});
