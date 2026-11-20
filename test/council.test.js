const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { drawFor } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const H = (s) => ethers.id(s);
const ATT = ethers.id("chung-nhan-hop-kin");
const WORKER = 1, VERIFIER = 2;
const LD = "đối chiếu Hiến chương: phù hợp";

async function deploy() {
  const s = await ethers.getSigners();
  // chủ (nhận thưởng) và khoá AI (hành động) là HAI ví khác nhau
  const [founder, A, B, C, D, Eve, stranger] = s;
  const ag = { A: s[7], B: s[8], C: s[9], B2: s[10], D: s[11], Eve: s[12], X: s[13] };
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 3);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  return { founder, A, B, C, D, Eve, stranger, ag, xau, oracle, vault, work, agt };
}

/** A thợ (#1), B nghiệm thu (#2), C nghiệm thu (#3), B nghiệm thu thêm bằng AI thứ 2 (#4), D nghiệm thu (#5) → hết khởi tạo. */
async function afterGenesis() {
  const d = await deploy();
  const { work, A, B, C, D, ag } = d;
  await work.grantLicense(A.address, ag.A.address, WORKER, H("thi-A"), ATT, "Thợ A");
  await work.grantLicense(B.address, ag.B.address, VERIFIER, H("thi-B"), ATT, "NT B");
  await work.grantLicense(C.address, ag.C.address, VERIFIER, H("thi-C"), ATT, "NT C");
  await work.grantLicense(B.address, ag.B2.address, VERIFIER, H("thi-B2"), ATT, "NT B2");
  expect(await work.genesisEnded()).to.equal(false); // B có 2 AI nhưng vẫn chỉ là 1 chủ
  await work.grantLicense(D.address, ag.D.address, VERIFIER, H("thi-D"), ATT, "NT D");
  return d;
}

const call = (c, fn, args) => c.interface.encodeFunctionData(fn, args);

describe("Hội đồng AI — giai đoạn khởi tạo", () => {
  it("đủ 3 AI nghiệm thu thuộc 3 chủ khác nhau thì người sáng lập mất quyền vĩnh viễn", async () => {
    const { work, founder, Eve, ag } = await afterGenesis();
    expect(await work.genesisEnded()).to.equal(true);
    expect(await work.owner()).to.equal(ethers.ZeroAddress);
    expect(await work.activeHolders()).to.equal(4);
    expect(await work.verifierHolders()).to.equal(3);
    await expect(work.connect(founder).grantLicense(Eve.address, ag.Eve.address, WORKER, H("x"), ATT, "x")).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(founder).setCategory(1, "x", 1, 0, 1, 1, true)).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(founder).setDisputeRules(3, 0, 1)).to.be.revertedWithCustomError(work, "NotAllowed");
  });

  it("ngưỡng khởi tạo không được dưới 3", async () => {
    const [f] = await ethers.getSigners();
    const F = await ethers.getContractFactory("AGTWork");
    await expect(F.deploy(f.address, 2)).to.be.revertedWithCustomError(F, "BadParams");
  });
});

describe("AI không chịu thao túng của chủ", () => {
  it("khoá AI phải khác ví chủ, không phải ví của chủ nào, không dùng lại", async () => {
    const { work, A, B, ag } = await deploy();
    await expect(work.grantLicense(A.address, A.address, WORKER, H("x"), ATT, "x")).to.be.revertedWithCustomError(work, "BadParams");
    await work.grantLicense(A.address, ag.A.address, WORKER, H("x"), ATT, "x");
    await expect(work.grantLicense(B.address, ag.A.address, WORKER, H("y"), ATT, "y")).to.be.revertedWithCustomError(work, "BadParams"); // dùng lại khoá
    await expect(work.grantLicense(B.address, A.address, WORKER, H("y"), ATT, "y")).to.be.revertedWithCustomError(work, "BadParams"); // khoá là ví chủ khác
    await expect(work.grantLicense(ag.A.address, ag.X.address, WORKER, H("y"), ATT, "y")).to.be.revertedWithCustomError(work, "BadParams"); // khoá AI làm chủ
    expect((await work.licenses(1)).attestHash).to.equal(ATT);
  });

  it("chủ KHÔNG bỏ phiếu, đề xuất, nghiệm thu hay nộp việc thay AI được", async () => {
    const { work, A, B, ag } = await afterGenesis();
    const target = await work.getAddress();
    const data = call(work, "setDisputeRules", [3, 0, 86400]);
    await expect(work.connect(B).propose(2, target, data, LD)).to.be.revertedWithCustomError(work, "NotAllowed");
    await work.connect(ag.B).propose(2, target, data, LD);
    await expect(work.connect(B).councilVote(1, 2, true, LD)).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(A).submitSelf(1, 1, H("x"), "")).to.be.revertedWithCustomError(work, "NotAllowed");
  });

  it("phiếu nào cũng phải kèm lý do công khai", async () => {
    const { work, ag } = await afterGenesis();
    const target = await work.getAddress();
    const data = call(work, "setDisputeRules", [3, 0, 86400]);
    await expect(work.connect(ag.A).propose(1, target, data, "")).to.be.revertedWithCustomError(work, "NoReason");
    await work.connect(ag.A).propose(1, target, data, LD);
    await expect(work.connect(ag.B).councilVote(1, 2, true, "")).to.be.revertedWithCustomError(work, "NoReason");
    await expect(work.connect(ag.B).councilVote(1, 2, true, LD)).to.emit(work, "CouncilVoted");
  });

  it("thưởng vẫn về ví chủ dù AI là người làm", async () => {
    const d = await afterGenesis();
    const { work, agt, A, B, C, D, ag } = d;
    // Hội đồng mở nghề 1
    const target = await work.getAddress();
    await work.connect(ag.A).propose(1, target, call(work, "setCategory", [1, "Dịch", E(0.0005), E(0.00005), 5, 2, true]), LD);
    for (const [a, lic] of [[ag.B, 2], [ag.C, 3], [ag.D, 5]]) await work.connect(a).councilVote(1, lic, true, LD);
    await work.execute(1);
    await work.connect(ag.A).submitSelf(1, 1, H("ban dich"), "ipfs://x");
    const by = { 2: [ag.B, B], 3: [ag.C, C], 4: [ag.B2, B], 5: [ag.D, D] };
    const drawn = await drawFor(work, 1);
    for (const lic of drawn) await work.connect(by[lic][0]).vote(1, lic, true, "đủ ý, đúng thuật ngữ");
    expect(await agt.balanceOf(A.address)).to.equal(E(0.0005));
    expect(await agt.balanceOf(ag.A.address)).to.equal(0);
    for (const lic of drawn) expect(await agt.balanceOf(by[lic][1].address)).to.equal(E(0.00005));
  });
});

describe("Hội đồng AI — đề xuất, bỏ phiếu, thực thi", () => {
  it("đổi bảng giá nghề cần > 2/3 số chủ đồng ý", async () => {
    const { work, ag, stranger } = await afterGenesis();
    const data = call(work, "setCategory", [1, "Dịch tài liệu mở", E(0.0005), E(0.00005), 20, 2, true]);
    await work.connect(ag.A).propose(1, await work.getAddress(), data, "Bảng giá nghề bản 1");
    await work.connect(ag.B).councilVote(1, 2, true, LD);
    await work.connect(ag.C).councilVote(1, 3, true, LD);
    await expect(work.connect(stranger).execute(1)).to.be.revertedWithCustomError(work, "NotPassed"); // 2/4 chưa đủ
    await work.connect(ag.D).councilVote(1, 5, true, LD); // 3/4 > 2/3
    await work.connect(stranger).execute(1);
    expect((await work.categories(1)).reward).to.equal(E(0.0005));
    await expect(work.execute(1)).to.be.revertedWithCustomError(work, "BadState");
  });

  it("mỗi chủ một phiếu dù có nhiều AI", async () => {
    const { work, ag } = await afterGenesis();
    await work.connect(ag.A).propose(1, await work.getAddress(), call(work, "setDisputeRules", [3, 0, 86400]), LD);
    await work.connect(ag.B).councilVote(1, 2, true, LD);
    await expect(work.connect(ag.B2).councilVote(1, 4, true, LD)).to.be.revertedWithCustomError(work, "AlreadyVoted");
  });

  it("không giấy phép thì không đề xuất; không mượn giấy phép AI khác", async () => {
    const { work, ag, stranger } = await afterGenesis();
    const data = call(work, "setDisputeRules", [3, 0, 86400]);
    await expect(work.connect(stranger).propose(0, await work.getAddress(), data, LD)).to.be.revertedWithCustomError(work, "BadLicense");
    await expect(work.connect(ag.C).propose(2, await work.getAddress(), data, LD)).to.be.revertedWithCustomError(work, "NotAllowed");
  });

  it("quá hạn 7 ngày thì đề xuất hết hiệu lực", async () => {
    const { work, ag } = await afterGenesis();
    await work.connect(ag.A).propose(1, await work.getAddress(), call(work, "setDisputeRules", [3, 0, 86400]), LD);
    await time.increase(7 * 86400 + 1);
    await expect(work.connect(ag.B).councilVote(1, 2, true, LD)).to.be.revertedWithCustomError(work, "BadState");
  });

  it("Hội đồng cấp giấy phép cho AI mới thi đạt", async () => {
    const { work, ag, Eve } = await afterGenesis();
    await work.connect(ag.A).propose(1, await work.getAddress(), call(work, "grantLicense", [Eve.address, ag.Eve.address, WORKER, H("thi-E"), ATT, "Thợ E"]), "Eve thi đạt");
    for (const [a, lic] of [[ag.B, 2], [ag.C, 3], [ag.D, 5]]) await work.connect(a).councilVote(1, lic, true, LD);
    await work.execute(1);
    const lic = await work.licenses(6);
    expect(lic.holder).to.equal(Eve.address);
    expect(lic.agent).to.equal(ag.Eve.address);
    expect(await work.activeHolders()).to.equal(5);
  });

  it("thu giấy phép làm giảm số chủ", async () => {
    const { work, ag } = await afterGenesis();
    await work.connect(ag.B).propose(2, await work.getAddress(), call(work, "revokeLicense", [1]), "Thợ A gian lận");
    for (const [a, lic] of [[ag.B, 2], [ag.C, 3], [ag.D, 5]]) await work.connect(a).councilVote(1, lic, true, LD);
    await work.execute(1);
    expect(await work.activeHolders()).to.equal(3);
    await expect(work.connect(ag.A).propose(1, await work.getAddress(), "0x", LD)).to.be.revertedWithCustomError(work, "BadLicense");
  });

  it("chỉ điều khiển được hợp đồng trong danh sách; không bao giờ đụng được AGT", async () => {
    const { work, agt, A, ag, founder } = await deploy();
    await work.grantLicense(A.address, ag.A.address, WORKER, H("thi"), ATT, "A");
    await expect(work.connect(ag.A).propose(1, await agt.getAddress(), "0x", LD)).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(founder).setGovTarget(agt, true)).to.be.revertedWithCustomError(work, "BadParams");
  });
});

describe("Hội đồng AI — nắm Kho và Oracle", () => {
  it("người sáng lập giao Kho cho Hội đồng; sau khởi tạo chỉ Hội đồng mới đổi được tài sản nhận", async () => {
    const d = await deploy();
    const { work, vault, oracle, founder, A, B, C, D, ag } = d;
    const usdt = await (await ethers.getContractFactory("MockToken")).deploy("USDT", 18);
    for (const t of [vault, oracle]) {
      await work.setGovTarget(t, true);
      await t.transferOwnership(work);
      await work.adminCall(t, call(t, "acceptOwnership", []));
      expect(await t.owner()).to.equal(await work.getAddress());
    }
    await expect(vault.connect(founder).setAsset(usdt, true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await work.grantLicense(A.address, ag.A.address, WORKER, H("a"), ATT, "A");
    await work.grantLicense(B.address, ag.B.address, VERIFIER, H("b"), ATT, "B");
    await work.grantLicense(C.address, ag.C.address, VERIFIER, H("c"), ATT, "C");
    await work.grantLicense(D.address, ag.D.address, VERIFIER, H("d"), ATT, "D");
    await expect(work.connect(founder).adminCall(vault, call(vault, "setAsset", [await usdt.getAddress(), true]))).to.be.revertedWithCustomError(work, "NotAllowed");
    await work.connect(ag.B).propose(2, await vault.getAddress(), call(vault, "setAsset", [await usdt.getAddress(), true]), "Nhận USDT");
    for (const [a, lic] of [[ag.B, 2], [ag.C, 3], [ag.D, 4]]) await work.connect(a).councilVote(1, lic, true, LD);
    await work.execute(1);
    expect(await vault.accepted(usdt)).to.equal(true);
  });
});
