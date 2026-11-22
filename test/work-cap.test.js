// Limits on the work mint door (AGT.sol; docs/decisions/2026-11-22-work-mint-cap.md, Claude + Codex).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const A = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [vault, work, alice, bob, anyone] = await ethers.getSigners();
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault.address, work.address);
  return { agt, vault, work, alice, bob, anyone };
}

describe("AGT work mint limits", () => {
  it("day one, empty Vault: work is paid up to 1 AGT a day; the rest is owed, never lost", async () => {
    const { agt, work, alice } = await deploy();
    await agt.connect(work).mintFromWork(alice.address, A(0.4));
    await agt.connect(work).mintFromWork(alice.address, A(0.9));
    expect(await agt.balanceOf(alice.address)).to.equal(A(1));
    expect(await agt.workOwed(alice.address)).to.equal(A(0.3));
    expect(await agt.workRoom()).to.equal(0n);
  });

  it("while pay is owed, new work joins the queue; the next day anyone can settle the debt", async () => {
    const { agt, work, alice, bob, anyone } = await deploy();
    await agt.connect(work).mintFromWork(alice.address, A(1.5)); // 1 paid, 0.5 owed
    await time.increase(86400);
    await agt.connect(work).mintFromWork(bob.address, A(0.2)); // owed debt exists: bob queues behind
    expect(await agt.balanceOf(bob.address)).to.equal(0n);
    expect(await agt.workOwed(bob.address)).to.equal(A(0.2));
    await agt.connect(anyone).claimWork(alice.address);
    await agt.connect(anyone).claimWork(bob.address);
    expect(await agt.balanceOf(alice.address)).to.equal(A(1.5));
    expect(await agt.balanceOf(bob.address)).to.equal(A(0.2));
    expect(await agt.totalWorkOwed()).to.equal(0n);
  });

  it("the lifetime bootstrap is 100 AGT with an empty Vault", async () => {
    const { agt, work, alice } = await deploy();
    for (let d = 0; d < 101; d++) {
      await agt.connect(work).mintFromWork(alice.address, A(1));
      await time.increase(86400);
    }
    expect(await agt.mintedByWork()).to.equal(A(100));
    expect(await agt.workOwed(alice.address)).to.equal(0n, "pay beyond the lifetime limit is not owed (Codex W-2)");
    expect(await agt.totalWorkOwed()).to.equal(0n);
  });

  it("debts never exceed what the lifetime limit can still pay, so the queue cannot jam (Codex W-2)", async () => {
    const { agt, work, alice, bob } = await deploy();
    await agt.connect(work).mintFromWork(alice.address, A(500)); // 1 paid today, 99 owed, 400 beyond the limit
    expect(await agt.workOwed(alice.address)).to.equal(A(99));
    await agt.connect(work).mintFromWork(bob.address, A(5)); // nothing left under the lifetime limit
    expect(await agt.workOwed(bob.address)).to.equal(0n);
    for (let d = 0; d < 99; d++) { await time.increase(86400); await agt.claimWork(alice.address); }
    expect(await agt.balanceOf(alice.address)).to.equal(A(100));
    expect(await agt.totalWorkOwed()).to.equal(0n);
  });

  it("claimWork always pays the debt's owner, whoever calls it (Codex W-1 checked: not a bug)", async () => {
    const { agt, work, alice, anyone } = await deploy();
    await agt.connect(work).mintFromWork(alice.address, A(2));
    await time.increase(86400);
    await agt.connect(anyone).claimWork(anyone.address); // the caller has no debt: nothing happens
    expect(await agt.balanceOf(anyone.address)).to.equal(0n);
    await agt.connect(anyone).claimWork(alice.address);
    expect(await agt.balanceOf(alice.address)).to.equal(A(2));
  });

  it("Vault deposits raise both limits: work can never exceed 1/19 of the Vault beyond the bootstrap (>= 95% backed)", async () => {
    const { agt, vault, work, alice } = await deploy();
    await agt.connect(vault).mintFromVault(alice.address, A(36500)); // day limit 1 + 10 = 11, lifetime 100 + 1921
    expect(await agt.workRoom()).to.equal(A(11));
    await agt.connect(work).mintFromWork(alice.address, A(50));
    expect(await agt.mintedByWork()).to.equal(A(11));
    const life = A(100) + A(36500) / 19n;
    for (let d = 0; d < 200; d++) {
      await time.increase(86400);
      await agt.connect(work).mintFromWork(alice.address, A(11));
      if ((await agt.totalWorkOwed()) > 0n) await agt.claimWork(alice.address);
    }
    expect(await agt.mintedByWork()).to.equal(life);
    expect((await agt.mintedByWork()) - A(100)).to.be.lte((await agt.mintedByVault()) / 19n);
  });

  it("the daily limit tops out at 100 AGT however large the Vault, and the limits are constants", async () => {
    const { agt, vault, work, alice } = await deploy();
    await agt.connect(vault).mintFromVault(alice.address, A(10_000_000));
    expect(await agt.workRoom()).to.equal(A(100));
    expect(await agt.WORK_MAX()).to.equal(A(1_000_000));
    await expect(agt.connect(alice).mintFromWork(alice.address, 1n)).to.be.revertedWithCustomError(agt, "NotWork");
  });
});
