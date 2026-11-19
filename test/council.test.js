const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const H = (s) => ethers.id(s);
const WORKER = 1, VERIFIER = 2;

async function deploy() {
  const [founder, A, B, C, D, Eve, stranger] = await ethers.getSigners();
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 3);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  return { founder, A, B, C, D, Eve, stranger, xau, oracle, vault, work, agt };
}

/** Khởi tạo: A thợ (#1), B nghiệm thu (#2), C nghiệm thu (#3), B nghiệm thu thêm (#4), D nghiệm thu (#5) → kết thúc khởi tạo. */
async function afterGenesis() {
  const d = await deploy();
  const { work, A, B, C, D } = d;
  await work.grantLicense(A.address, WORKER, H("thi-A"), "Thợ A");
  await work.grantLicense(B.address, VERIFIER, H("thi-B"), "NT B");
  await work.grantLicense(C.address, VERIFIER, H("thi-C"), "NT C");
  await work.grantLicense(B.address, VERIFIER, H("thi-B2"), "NT B2");
  expect(await work.genesisEnded()).to.equal(false); // B có 2 giấy phép nhưng vẫn chỉ là 1 chủ
  await work.grantLicense(D.address, VERIFIER, H("thi-D"), "NT D");
  return d;
}

const call = (c, fn, args) => c.interface.encodeFunctionData(fn, args);

describe("Hội đồng AI — giai đoạn khởi tạo", () => {
  it("đủ 3 AI nghiệm thu thuộc 3 chủ khác nhau thì người sáng lập mất quyền vĩnh viễn", async () => {
    const { work, founder, Eve } = await afterGenesis();
    expect(await work.genesisEnded()).to.equal(true);
    expect(await work.owner()).to.equal(ethers.ZeroAddress);
    expect(await work.activeHolders()).to.equal(4);
    expect(await work.verifierHolders()).to.equal(3);
    await expect(work.connect(founder).grantLicense(Eve.address, WORKER, H("x"), "x")).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(founder).setCategory(1, "x", 1, 0, 1, 1, true)).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(founder).setDisputeRules(3, 0, 1)).to.be.revertedWithCustomError(work, "NotAllowed");
  });

  it("ngưỡng khởi tạo không được dưới 3", async () => {
    const [f] = await ethers.getSigners();
    const F = await ethers.getContractFactory("AGTWork");
    await expect(F.deploy(f.address, 2)).to.be.revertedWithCustomError(F, "BadParams");
  });
});

describe("Hội đồng AI — đề xuất, bỏ phiếu, thực thi", () => {
  it("đổi bảng giá nghề cần > 2/3 số chủ đồng ý", async () => {
    const { work, A, B, C, D, stranger } = await afterGenesis();
    const data = call(work, "setCategory", [1, "Dịch tài liệu mở", E(0.0005), E(0.00005), 20, 2, true]);
    await work.connect(A).propose(1, await work.getAddress(), data, "Bảng giá nghề bản 1");
    await work.connect(B).councilVote(1, 2, true);
    await work.connect(C).councilVote(1, 3, true);
    await expect(work.connect(stranger).execute(1)).to.be.revertedWithCustomError(work, "NotPassed"); // 2/4 chưa đủ
    await work.connect(D).councilVote(1, 5, true); // 3/4 > 2/3
    await work.connect(stranger).execute(1);
    expect((await work.categories(1)).reward).to.equal(E(0.0005));
    await expect(work.execute(1)).to.be.revertedWithCustomError(work, "BadState"); // không chạy lại được
  });

  it("mỗi chủ một phiếu dù có nhiều giấy phép", async () => {
    const { work, A, B } = await afterGenesis();
    await work.connect(A).propose(1, await work.getAddress(), call(work, "setDisputeRules", [3, 0, 86400]), "");
    await work.connect(B).councilVote(1, 2, true);
    await expect(work.connect(B).councilVote(1, 4, true)).to.be.revertedWithCustomError(work, "AlreadyVoted");
  });

  it("không giấy phép thì không đề xuất, không bỏ phiếu; không mượn giấy phép người khác", async () => {
    const { work, B, stranger } = await afterGenesis();
    const data = call(work, "setDisputeRules", [3, 0, 86400]);
    await expect(work.connect(stranger).propose(0, await work.getAddress(), data, "")).to.be.revertedWithCustomError(work, "BadLicense");
    await expect(work.connect(stranger).propose(2, await work.getAddress(), data, "")).to.be.revertedWithCustomError(work, "NotAllowed");
    await work.connect(B).propose(2, await work.getAddress(), data, "");
    await expect(work.connect(stranger).councilVote(1, 2, true)).to.be.revertedWithCustomError(work, "NotAllowed");
  });

  it("quá hạn 7 ngày thì đề xuất hết hiệu lực", async () => {
    const { work, A, B } = await afterGenesis();
    await work.connect(A).propose(1, await work.getAddress(), call(work, "setDisputeRules", [3, 0, 86400]), "");
    await time.increase(7 * 86400 + 1);
    await expect(work.connect(B).councilVote(1, 2, true)).to.be.revertedWithCustomError(work, "BadState");
  });

  it("Hội đồng cấp giấy phép cho AI mới thi đạt", async () => {
    const { work, A, B, C, D, Eve } = await afterGenesis();
    await work.connect(A).propose(1, await work.getAddress(), call(work, "grantLicense", [Eve.address, WORKER, H("thi-E"), "Thợ E"]), "Eve thi đạt");
    for (const [s, lic] of [[B, 2], [C, 3], [D, 5]]) await work.connect(s).councilVote(1, lic, true);
    await work.execute(1);
    const lic = await work.licenses(6);
    expect(lic.holder).to.equal(Eve.address);
    expect(await work.activeHolders()).to.equal(5);
  });

  it("thu giấy phép làm giảm số chủ", async () => {
    const { work, A, B, C, D } = await afterGenesis();
    await work.connect(B).propose(2, await work.getAddress(), call(work, "revokeLicense", [1]), "Thợ A gian lận");
    for (const [s, lic] of [[B, 2], [C, 3], [D, 5]]) await work.connect(s).councilVote(1, lic, true);
    await work.execute(1);
    expect(await work.activeHolders()).to.equal(3);
    await expect(work.connect(A).propose(1, await work.getAddress(), "0x", "")).to.be.revertedWithCustomError(work, "BadLicense");
  });

  it("chỉ điều khiển được hợp đồng trong danh sách; không bao giờ đụng được AGT", async () => {
    const { work, agt, A, founder } = await deploy();
    await work.grantLicense(A.address, WORKER, H("thi"), "A");
    await expect(work.connect(A).propose(1, await agt.getAddress(), "0x", "")).to.be.revertedWithCustomError(work, "NotAllowed");
    await expect(work.connect(founder).setGovTarget(agt, true)).to.be.revertedWithCustomError(work, "BadParams");
  });
});

describe("Hội đồng AI — nắm Kho và Oracle", () => {
  it("người sáng lập giao Kho cho Hội đồng; sau khởi tạo chỉ Hội đồng mới đổi được tài sản nhận", async () => {
    const d = await deploy();
    const { work, vault, oracle, founder, A, B, C, D } = d;
    const usdt = await (await ethers.getContractFactory("MockToken")).deploy("USDT", 18);
    // khởi tạo: giao Kho + Oracle cho Hội đồng
    for (const t of [vault, oracle]) {
      await work.setGovTarget(t, true);
      await t.transferOwnership(work);
      await work.adminCall(t, call(t, "acceptOwnership", []));
      expect(await t.owner()).to.equal(await work.getAddress());
    }
    await expect(vault.connect(founder).setAsset(usdt, true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    // kết thúc khởi tạo
    await work.grantLicense(A.address, WORKER, H("a"), "A");
    await work.grantLicense(B.address, VERIFIER, H("b"), "B");
    await work.grantLicense(C.address, VERIFIER, H("c"), "C");
    await work.grantLicense(D.address, VERIFIER, H("d"), "D");
    await expect(work.connect(founder).adminCall(vault, call(vault, "setAsset", [await usdt.getAddress(), true]))).to.be.revertedWithCustomError(work, "NotAllowed");
    // Hội đồng bỏ phiếu nhận USDT vào Kho
    await work.connect(B).propose(2, await vault.getAddress(), call(vault, "setAsset", [await usdt.getAddress(), true]), "Nhận USDT");
    for (const [s, lic] of [[B, 2], [C, 3], [D, 4]]) await work.connect(s).councilVote(1, lic, true);
    await work.execute(1);
    expect(await vault.accepted(usdt)).to.equal(true);
  });
});
