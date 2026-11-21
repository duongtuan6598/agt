const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { drawFor } = require("./helpers");

const H = (s) => ethers.id(s);
const ATT = ethers.id("att");

async function deploy() {
  const s = await ethers.getSigners();
  const [founder, A, B, stranger] = s;
  const agA = s[10], agB = s[11];
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 10);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  const HAT = await agt.HAT();
  await work.grantLicense(A.address, agA.address, 1, H("tA"), ATT, "Worker A");
  await work.grantLicense(B.address, agB.address, 2, H("tB"), ATT, "Verifier B");
  await work.setCategory(1, "Open-document translation", 1000n * HAT, 0, 10, 1, true);
  await work.setDailyBudget(1, 1000); // a self-found trade needs a budget (THIET-KE-LAM-PHAT.md)
  return { founder, A, B, agA, agB, stranger, work, agt, HAT };
}

async function doJob(work, agA, agB, i) {
  await work.connect(agA).submitSelf(1, 1, H("job" + i), "");
  const id = (await work.nextJob()) - 1n;
  await drawFor(work, id);
  await work.connect(agB).vote(id, 2, true, "checked against the source");
}

describe("Giá tự giảm khi cung vượt cầu (ngân sách ngày)", () => {
  it("trong ngân sách: giá giữ nguyên", async () => {
    const { work, agt, A, agA, agB, HAT } = await deploy();
    for (let i = 0; i < 4; i++) await doJob(work, agA, agB, i);
    expect(await agt.balanceOf(A.address)).to.equal(4000n * HAT);
  });

  it("ngân sách 0 = nghề không nhận việc tự tìm, không đúc gì (trước đây 0 nghĩa là không giới hạn)", async () => {
    const { work, agt, agA } = await deploy();
    await work.setDailyBudget(1, 0);
    await expect(work.connect(agA).submitSelf(1, 1, H("x"), "")).to.be.revertedWithCustomError(work, "NoBudget");
    expect(await agt.totalSupply()).to.equal(0n);
  });

  it("người chấm được trả trong cùng hệ số ngân sách, kể cả khi bác việc (spam việc dở không đúc thêm)", async () => {
    const { work, agt, A, B, agA, agB, HAT } = await deploy();
    await work.setCategory(1, "Open-document translation", 1000n * HAT, 100n * HAT, 50, 1, true);
    await work.setDailyBudget(1, 2);
    const paid = [];
    for (let i = 0; i < 4; i++) {
      const before = await agt.balanceOf(B.address);
      await work.connect(agA).submitSelf(1, 1, H("bad" + i), "");
      const id = (await work.nextJob()) - 1n;
      await drawFor(work, id);
      await work.connect(agB).vote(id, 2, false, "does not match the source"); // rejected
      paid.push((await agt.balanceOf(B.address)) - before);
    }
    expect(paid).to.deep.equal([100n * HAT, 100n * HAT, (100n * HAT * 2n) / 3n, 50n * HAT]);
    expect(await agt.balanceOf(A.address)).to.equal(0n);
  });

  it("trần cứng mỗi ngày: spam gấp nhiều lần ngân sách vẫn không đúc quá trần; sang ngày mới trần làm mới", async () => {
    const { work, agt, A, B, agA, agB, HAT } = await deploy();
    await work.setCategory(1, "Open-document translation", 1000n * HAT, 100n * HAT, 60, 1, true);
    await work.setDailyBudget(1, 2);
    const ceiling = await work.dailyCeiling(1);
    expect(ceiling).to.equal(2n * 2n * (1000n + 100n) * HAT);
    for (let i = 0; i < 40; i++) await doJob(work, agA, agB, i);
    const minted = (await agt.balanceOf(A.address)) + (await agt.balanceOf(B.address));
    expect(minted).to.equal(ceiling, "40 jobs at budget 2 would mint more without the ceiling: it is reached exactly");
    await time.increase(86400);
    const before = await agt.balanceOf(A.address);
    await doJob(work, agA, agB, 999);
    expect((await agt.balanceOf(A.address)) - before).to.equal(1000n * HAT, "a new day, a fresh ceiling");
  });

  it("vượt ngân sách thì giá mỗi việc = giá × ngân sách ÷ số việc trong ngày", async () => {
    const { work, agt, A, agA, agB, HAT } = await deploy();
    await work.setDailyBudget(1, 2);
    const paid = [];
    for (let i = 0; i < 4; i++) {
      const quote = await work.currentReward(1);
      const before = await agt.balanceOf(A.address);
      await doJob(work, agA, agB, i);
      const got = (await agt.balanceOf(A.address)) - before;
      expect(got).to.equal(quote); // giá báo trước = giá trả thật
      paid.push(got / (HAT / 1000n)); // đơn vị mili-Hạt cho dễ đọc
    }
    // 1000, 1000, 1000×2/3, 1000×2/4
    expect(paid.map(Number)).to.deep.equal([1000000, 1000000, 666666, 500000]);
  });

  it("sang ngày mới giá về lại đủ", async () => {
    const { work, agA, agB, HAT } = await deploy();
    await work.setDailyBudget(1, 1);
    await doJob(work, agA, agB, 0);
    await doJob(work, agA, agB, 1);
    expect(await work.currentReward(1)).to.equal((1000n * HAT * 1n) / 3n);
    await time.increase(86400);
    expect(await work.currentReward(1)).to.equal(1000n * HAT);
  });

  it("chỉ quản trị (khởi tạo: người sáng lập; sau đó: Hội đồng) mới đặt được ngân sách", async () => {
    const { work, stranger } = await deploy();
    await expect(work.connect(stranger).setDailyBudget(1, 5)).to.be.revertedWithCustomError(work, "NotAllowed");
  });
});
