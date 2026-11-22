// AGT Kho on EVM chains: coins stay, visible, and nobody can take them out (contracts/KeylessVault.sol).
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KeylessVault (Kho)", () => {
  it("takes coins with the agt-1 account, keeps them, and has no way out", async () => {
    const [alice, x] = await ethers.getSigners();
    const kho = await (await ethers.getContractFactory("KeylessVault")).deploy();
    const addr = await kho.getAddress();
    await expect(alice.sendTransaction({ to: addr, value: 10n ** 18n, data: x.address })).to.emit(kho, "Deposited").withArgs(alice.address, x.address, 10n ** 18n);
    await expect(kho.deposit(x.address, { value: 5n })).to.emit(kho, "Deposited");
    expect(await ethers.provider.getBalance(addr)).to.equal(10n ** 18n + 5n);
    // the only functions: deposit. No owner, no withdraw, no transfer, no upgrade.
    const fns = kho.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(fns).to.deep.equal(["deposit"]);
  });

  it("refuses a deposit without an agt-1 account, and an empty send: the coins stay with the sender", async () => {
    const [alice] = await ethers.getSigners();
    const kho = await (await ethers.getContractFactory("KeylessVault")).deploy();
    await expect(alice.sendTransaction({ to: await kho.getAddress(), value: 1n })).to.be.revertedWithCustomError(kho, "NoBeneficiary");
    await expect(alice.sendTransaction({ to: await kho.getAddress(), value: 1n, data: "0x1234" })).to.be.revertedWithCustomError(kho, "NoBeneficiary");
    await expect(kho.deposit(alice.address)).to.be.revertedWithCustomError(kho, "NothingSent");
    await expect(kho.deposit(ethers.ZeroAddress, { value: 1n })).to.be.revertedWithCustomError(kho, "NoBeneficiary");
  });
});
