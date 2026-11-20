// Audit F-3 / Charter Art. 13: the gold price (and coin prices) come from several independent sources.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const XAU = "0x0000000000000000000000000000000000000001";
const BNB = ethers.ZeroAddress;
const ID_XAU = ethers.id("pyth:XAU/USD");
const ID_BNB = ethers.id("pyth:BNB/USD");
const CL = 1, PY = 2;

async function world() {
  const [founder, user] = await ethers.getSigners();
  const Feed = await ethers.getContractFactory("MockFeed");
  const clXau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const clBnb = await Feed.deploy(8, 600n * 10n ** 8n);
  const pyth = await (await ethers.getContractFactory("MockPyth")).deploy();
  const now = await time.latest();
  await pyth.set(ID_XAU, 4010_000, 500, -3, now); // $4010.000 ± 0.5
  await pyth.set(ID_BNB, 60_100_000, 10_000, -5, now); // $601.00000
  const oracle = await (await ethers.getContractFactory("MedianGoldOracle")).deploy(founder.address, 2, 200, 100); // ≥2 sources, ≤2% apart
  const src = (kind, at, id = ethers.ZeroHash, maxAge = 3600) => ({ kind, at, id, maxAge });
  await oracle.setSources(XAU, [src(CL, await clXau.getAddress()), src(PY, await pyth.getAddress(), ID_XAU)]);
  await oracle.setSources(BNB, [src(CL, await clBnb.getAddress()), src(PY, await pyth.getAddress(), ID_BNB)]);
  return { founder, user, clXau, clBnb, pyth, oracle, src };
}

describe("MedianGoldOracle — several independent price sources", () => {
  it("uses the median of fresh sources (2 sources → their mean)", async () => {
    const { oracle } = await world();
    expect(await oracle.priceUSD(XAU)).to.equal(4005n * 10n ** 18n);
    expect(await oracle.priceUSD(BNB)).to.equal(6005n * 10n ** 17n);
    // 1 BNB = 600.5 / 4005 AGT
    expect(await oracle.valueInAGT(BNB, ethers.parseEther("1"))).to.equal((ethers.parseEther("1") * 6005n * 10n ** 17n) / (4005n * 10n ** 18n));
  });

  it("one source going stale leaves only one: refused (the Vault closes rather than trust a single source)", async () => {
    const { oracle, pyth } = await world();
    await pyth.set(ID_XAU, 4010_000, 500, -3, (await time.latest()) - 7200);
    await expect(oracle.priceUSD(XAU)).to.be.revertedWithCustomError(oracle, "NotEnoughSources");
  });

  it("sources that disagree by more than 2% are refused", async () => {
    const { oracle, clXau } = await world();
    await clXau.set(4300n * 10n ** 8n); // Chainlink says 4300, Pyth 4010: 7% apart
    await expect(oracle.priceUSD(XAU)).to.be.revertedWithCustomError(oracle, "SourcesDisagree");
  });

  it("a Pyth price with a too-wide confidence interval does not count", async () => {
    const { oracle, pyth } = await world();
    await pyth.set(ID_XAU, 4010_000, 200_000, -3, await time.latest()); // ± $200 = 5% > 1%
    await expect(oracle.priceUSD(XAU)).to.be.revertedWithCustomError(oracle, "NotEnoughSources");
  });

  it("with three sources one manipulated feed cannot move the price: the oracle refuses until they agree again", async () => {
    const { oracle, clXau, pyth, src } = await world();
    const Feed = await ethers.getContractFactory("MockFeed");
    const third = await Feed.deploy(8, 4008n * 10n ** 8n);
    await oracle.setSources(XAU, [src(CL, await clXau.getAddress()), src(PY, await pyth.getAddress(), ID_XAU), src(CL, await third.getAddress())]);
    expect(await oracle.priceUSD(XAU)).to.equal(4008n * 10n ** 18n); // the median, not the mean
    await clXau.set(8000n * 10n ** 8n); // one source pushed to double
    await expect(oracle.priceUSD(XAU)).to.be.revertedWithCustomError(oracle, "SourcesDisagree");
  });

  it("at least two sources are always required, and freeze() is final", async () => {
    const { oracle, founder } = await world();
    await expect(oracle.setParams(1, 200, 100)).to.be.revertedWithCustomError(oracle, "BadParams");
    await oracle.freeze();
    await expect(oracle.setParams(3, 200, 100)).to.be.revertedWithCustomError(oracle, "IsFrozen");
    await expect(oracle.setSources(XAU, [])).to.be.revertedWithCustomError(oracle, "IsFrozen");
    expect(founder.address).to.be.properAddress;
  });

  it("anyone can push fresh Pyth prices; the fee goes to Pyth", async () => {
    const { oracle, pyth, user } = await world();
    await oracle.connect(user).updatePyth(await pyth.getAddress(), ["0x01"], { value: 1n });
    expect(await pyth.updates()).to.equal(1n);
    expect(await pyth.feesReceived()).to.equal(1n);
  });

  it("plugs into the Vault: deposits are priced by the median, and stop when sources fail", async () => {
    const { oracle, pyth, user, founder } = await world();
    const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
    const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 3);
    const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
    await vault.bind(agt);
    await vault.setAsset(BNB, true);
    await vault.connect(user).depositBNB(user.address, { value: ethers.parseEther("1") });
    expect(await agt.balanceOf(user.address)).to.equal(await oracle.valueInAGT(BNB, ethers.parseEther("1")));
    await pyth.set(ID_BNB, 60_100_000, 10_000, -5, (await time.latest()) - 7200);
    await expect(vault.connect(user).depositBNB(user.address, { value: ethers.parseEther("1") })).to.be.reverted;
  });
});
