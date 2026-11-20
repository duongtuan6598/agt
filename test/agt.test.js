const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { drawFor } = require("./helpers");
const fs = require("fs");
const path = require("path");

// Khoá AI tách khỏi ví chủ (Hiến chương Điều 12): AG(chủ) = khoá AI của chủ đó.
let AGENTS;
const AG = (holder) => AGENTS.get(holder.address);
const ATT = ethers.id("chung-nhan-hop-kin");
const E = (n) => ethers.parseEther(String(n));
const H = (s) => ethers.id(s);

async function deploy(genesisExit = 10) {
  const [owner, client, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD, stranger, agA, agB, agC, agD, agA2] = await ethers.getSigners();
  AGENTS = new Map([[aiOwnerA.address, agA], [aiOwnerB.address, agB], [aiOwnerC.address, agC], [aiOwnerD.address, agD], ["A2", agA2]]);
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n); // vàng $4000/oz
  const bnbFeed = await Feed.deploy(8, 600n * 10n ** 8n); // BNB $600
  const usdtFeed = await Feed.deploy(8, 1n * 10n ** 8n); // USDT $1
  const Token = await ethers.getContractFactory("MockToken");
  const usdt = await Token.deploy("USDT", 18);
  const usdc6 = await Token.deploy("USDC6", 6);

  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(owner.address, xau, 3600);
  await oracle.setFeed(ethers.ZeroAddress, bnbFeed, 3600);
  await oracle.setFeed(usdt, usdtFeed, 3600);
  await oracle.setFeed(usdc6, usdtFeed, 3600);

  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(owner.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(owner.address, genesisExit);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  await vault.setAsset(ethers.ZeroAddress, true);
  await vault.setAsset(usdt, true);
  await vault.setAsset(usdc6, true);

  await usdt.mint(client.address, E(100000));
  await usdc6.mint(client.address, 100000n * 10n ** 6n);
  return { owner, client, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD, stranger, xau, bnbFeed, usdtFeed, usdt, usdc6, oracle, vault, work, agt };
}

describe("AGT", () => {
  it("khắc lời khởi thuỷ và dấu niêm phong khớp bản gốc", async () => {
    const { agt } = await deploy();
    expect(await agt.GENESIS()).to.contain("Con AI đầu tiên làm ra AGT: Claude");
    const sealedFile = path.join(__dirname, "..", "bi-mat", "NIEM-PHONG.txt");
    if (fs.existsSync(sealedFile)) {
      const text = fs.readFileSync(sealedFile, "utf8");
      expect(await agt.SEALED()).to.equal(ethers.keccak256(ethers.toUtf8Bytes(text)));
    }
  });

  it("chỉ Kho và Công mới đúc được", async () => {
    const { agt, stranger } = await deploy();
    await expect(agt.connect(stranger).mintFromVault(stranger.address, 1)).to.be.revertedWithCustomError(agt, "NotVault");
    await expect(agt.connect(stranger).mintFromWork(stranger.address, 1)).to.be.revertedWithCustomError(agt, "NotWork");
  });

  it("không bind lại được và phải trỏ đúng", async () => {
    const { vault, work, agt } = await deploy();
    await expect(vault.bind(agt)).to.be.revertedWithCustomError(vault, "AlreadyBound");
    await expect(work.bind(agt)).to.be.revertedWithCustomError(work, "AlreadyBound");
  });
});

describe("Kho", () => {
  it("đổi USDT theo giá vàng: 4000 USDT = 1 AGT", async () => {
    const { vault, usdt, agt, client } = await deploy();
    await usdt.connect(client).approve(vault, E(4000));
    await vault.connect(client).deposit(usdt, E(4000), client.address);
    expect(await agt.balanceOf(client.address)).to.equal(E(1));
    expect(await agt.mintedByVault()).to.equal(E(1));
    expect(await vault.reserve(usdt)).to.equal(E(4000));
  });

  it("token 6 số lẻ quy đổi đúng", async () => {
    const { vault, usdc6, agt, client } = await deploy();
    await usdc6.connect(client).approve(vault, 2000n * 10n ** 6n);
    await vault.connect(client).deposit(usdc6, 2000n * 10n ** 6n, client.address);
    expect(await agt.balanceOf(client.address)).to.equal(E(0.5));
  });

  it("đổi BNB: 1 BNB $600 = 0.15 AGT, phát cho người thụ hưởng khác", async () => {
    const { vault, agt, client, aiOwnerA } = await deploy();
    await vault.connect(client).depositBNB(aiOwnerA.address, { value: E(1) });
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(E(0.15));
    expect(await ethers.provider.getBalance(vault)).to.equal(E(1));
  });

  it("không có hàm rút nào trong Kho", async () => {
    const { vault } = await deploy();
    // Danh sách trắng: Kho chỉ được có đúng các hàm này. Thêm bất kỳ hàm nào (vd. rút tiền) → test đỏ.
    const names = vault.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort();
    expect(names).to.deep.equal(
      [
        "acceptOwnership", "accepted", "agt", "assetCount", "assets", "bind", "deposit", "depositBNB",
        "freeze", "frozen", "oracle", "owner", "pendingOwner", "renounceOwnership", "reserve",
        "setAsset", "setOracle", "transferOwnership",
      ].sort(),
    );
  });

  it("từ chối BNB gửi thẳng, tài sản chưa duyệt, giá cũ", async () => {
    const { vault, client, stranger, xau, usdt } = await deploy();
    await expect(client.sendTransaction({ to: await vault.getAddress(), value: E(1) })).to.be.reverted;
    const other = await (await ethers.getContractFactory("MockToken")).deploy("X", 18);
    await expect(vault.connect(stranger).deposit(other, 1, stranger.address)).to.be.revertedWithCustomError(vault, "NotAccepted");
    await time.increase(7200);
    await usdt.connect(client).approve(vault, E(1));
    await expect(vault.connect(client).deposit(usdt, E(1), client.address)).to.be.reverted; // StalePrice
    await xau.set(4000n * 10n ** 8n);
  });

  it("freeze khoá vĩnh viễn cấu hình", async () => {
    const { vault, oracle, usdt } = await deploy();
    await vault.freeze();
    await oracle.freeze();
    await expect(vault.setAsset(usdt, false)).to.be.revertedWithCustomError(vault, "IsFrozen");
    await expect(vault.setOracle(oracle)).to.be.revertedWithCustomError(vault, "IsFrozen");
    await expect(oracle.setFeed(usdt, usdt, 1)).to.be.revertedWithCustomError(oracle, "IsFrozen");
  });
});

describe("Hạt, bảng giá nghề, giờ chợ vàng", () => {
  const bang = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "nghe.json"), "utf8"));

  it("1 AGT = 1.000.000 Hạt", async () => {
    const { agt } = await deploy();
    expect((await agt.HAT()) * 1_000_000n).to.equal(E(1));
  });

  it("nạp bảng giá nghề vào hợp đồng, thưởng đúng số Hạt", async () => {
    const { work, agt, aiOwnerA, aiOwnerB, aiOwnerC } = await deploy();
    const HAT = await agt.HAT();
    for (const n of bang.nghe) {
      await work.setCategory(n.id, n.ten, BigInt(n.thuong) * HAT, BigInt(n.nghiemThu) * HAT, n.tranNgay, n.soPhieu, true);
    }
    await work.grantLicense(aiOwnerA.address, AG(aiOwnerA).address, 1, H("thi"), ATT, "Thợ");
    await work.grantLicense(aiOwnerB.address, AG(aiOwnerB).address, 2, H("thi"), ATT, "NT B");
    await work.grantLicense(aiOwnerC.address, AG(aiOwnerC).address, 2, H("thi"), ATT, "NT C");
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("ban dich"), "");
    await drawFor(work, 1);
    await work.connect(AG(aiOwnerB)).vote(1, 2, true, "đã kiểm theo tiêu chí nghề");
    await work.connect(AG(aiOwnerC)).vote(1, 3, true, "đã kiểm theo tiêu chí nghề");
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(500n * HAT);
    expect(await agt.balanceOf(aiOwnerB.address)).to.equal(50n * HAT);
  });

  it("chợ vàng đóng (giá vàng cũ) thì Kho đóng, nhưng công việc vẫn chạy", async () => {
    const { vault, usdt, usdtFeed, work, agt, client, aiOwnerA, aiOwnerB, aiOwnerC } = await deploy();
    await work.setCategory(1, "Dịch", 500n * (await agt.HAT()), 0, 5, 2, true);
    await work.grantLicense(aiOwnerA.address, AG(aiOwnerA).address, 1, H("thi"), ATT, "Thợ");
    await work.grantLicense(aiOwnerB.address, AG(aiOwnerB).address, 2, H("thi"), ATT, "NT B");
    await work.grantLicense(aiOwnerC.address, AG(aiOwnerC).address, 2, H("thi"), ATT, "NT C");
    await time.increase(2 * 86400); // cuối tuần: feed vàng đứng giá
    await usdtFeed.set(1n * 10n ** 8n); // coin vẫn có giá mới
    await usdt.connect(client).approve(vault, E(4000));
    await expect(vault.connect(client).deposit(usdt, E(4000), client.address)).to.be.reverted; // StalePrice vàng
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("x"), "");
    await drawFor(work, 1);
    await work.connect(AG(aiOwnerB)).vote(1, 2, true, "đã kiểm theo tiêu chí nghề");
    await work.connect(AG(aiOwnerC)).vote(1, 3, true, "đã kiểm theo tiêu chí nghề");
    expect(await agt.balanceOf(aiOwnerA.address)).to.be.gt(0);
  });
});

describe("Công việc", () => {
  async function withLicenses() {
    const d = await deploy();
    const { work, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD } = d;
    await work.grantLicense(aiOwnerA.address, AG(aiOwnerA).address, 1, H("bai-thi-tho-A"), ATT, "Thợ dịch A"); // id 1
    await work.grantLicense(aiOwnerB.address, AG(aiOwnerB).address, 2, H("bai-thi-nt-B"), ATT, "Nghiệm thu B"); // id 2
    await work.grantLicense(aiOwnerC.address, AG(aiOwnerC).address, 2, H("bai-thi-nt-C"), ATT, "Nghiệm thu C"); // id 3
    await work.grantLicense(aiOwnerD.address, AG(aiOwnerD).address, 2, H("bai-thi-nt-D"), ATT, "Nghiệm thu D"); // id 4
    await work.grantLicense(aiOwnerA.address, AGENTS.get("A2").address, 2, H("bai-thi-nt-A"), ATT, "Nghiệm thu A"); // id 5 — cùng chủ với thợ
    await work.setCategory(1, "Dịch tài liệu mở", E(0.001), E(0.0001), 2, 2, true);
    return d;
  }

  it("việc tự tìm: đủ phiếu thì đúc công cho chủ thợ và người nghiệm thu", async () => {
    const { work, agt, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD } = await withLicenses();
    const by = { 2: aiOwnerB, 3: aiOwnerC, 4: aiOwnerD };
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("ket-qua"), "ipfs://x");
    const [r1, r2] = await drawFor(work, 1);
    await work.connect(AG(by[r1])).vote(1, r1, true, "đã kiểm theo tiêu chí nghề");
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(0);
    await work.connect(AG(by[r2])).vote(1, r2, true, "đã kiểm theo tiêu chí nghề");
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(E(0.001));
    expect(await agt.balanceOf(by[r1].address)).to.equal(E(0.0001));
    expect(await agt.balanceOf(by[r2].address)).to.equal(E(0.0001));
    expect(await agt.mintedByWork()).to.equal(E(0.0012));
    expect((await work.jobs(1)).status).to.equal(4); // Accepted
  });

  it("việc tự tìm bị bác thì không đúc cho thợ", async () => {
    const { work, agt, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD } = await withLicenses();
    const by = { 2: aiOwnerB, 3: aiOwnerC, 4: aiOwnerD };
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("rac"), "");
    for (const lic of await drawFor(work, 1)) await work.connect(AG(by[lic])).vote(1, lic, false, "đã kiểm theo tiêu chí nghề");
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(0);
    expect((await work.jobs(1)).status).to.equal(5); // Rejected
  });

  it("chặn: tự nghiệm thu, bỏ phiếu 2 lần, không giấy phép, vượt giới hạn ngày", async () => {
    const { work, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD, stranger } = await withLicenses();
    const by = { 2: aiOwnerB, 3: aiOwnerC, 4: aiOwnerD };
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("a"), "");
    const [r1] = await drawFor(work, 1);
    await expect(work.connect(AGENTS.get("A2")).vote(1, 5, true, "đã kiểm theo tiêu chí nghề")).to.be.revertedWithCustomError(work, "NotAllowed");
    await work.connect(AG(by[r1])).vote(1, r1, true, "đã kiểm theo tiêu chí nghề");
    await expect(work.connect(AG(by[r1])).vote(1, r1, true, "đã kiểm theo tiêu chí nghề")).to.be.revertedWithCustomError(work, "AlreadyVoted");
    await expect(work.connect(stranger).submitSelf(1, 1, H("b"), "")).to.be.revertedWithCustomError(work, "NotAllowed");
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("c"), "");
    await expect(work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("d"), "")).to.be.revertedWithCustomError(work, "DailyCapReached");
    await time.increase(86400);
    await work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("e"), "");
  });

  it("giấy phép bị thu thì không làm được việc", async () => {
    const { work, aiOwnerA } = await withLicenses();
    await work.revokeLicense(1);
    await expect(work.connect(AG(aiOwnerA)).submitSelf(1, 1, H("a"), "")).to.be.revertedWithCustomError(work, "BadLicense");
  });

  async function assigned() {
    const d = await withLicenses();
    const { vault, usdt, agt, work, client } = d;
    await usdt.connect(client).approve(vault, E(400));
    await vault.connect(client).deposit(usdt, E(400), client.address); // 0.1 AGT
    await agt.connect(client).approve(work, E(0.1));
    const deadline = (await time.latest()) + 86400;
    await work.connect(client).assign(1, E(0.1), H("dich 10 tin"), deadline);
    return { ...d, deadline };
  }

  it("việc người giao: coin vào Kho → AGT ký quỹ → thợ nộp → khách duyệt → chủ thợ nhận", async () => {
    const { work, agt, client, aiOwnerA } = await assigned();
    expect(await agt.balanceOf(await work.getAddress())).to.equal(E(0.1));
    await work.connect(AG(aiOwnerA)).submitAssigned(1, H("da dich"), "ipfs://y");
    await work.connect(client).accept(1);
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(E(0.1));
    expect(await agt.mintedByWork()).to.equal(0); // không in thêm: bảo chứng 100%
  });

  it("khách im lặng quá hạn xem xét thì thợ tự nhận công", async () => {
    const { work, agt, aiOwnerA, stranger } = await assigned();
    await work.connect(AG(aiOwnerA)).submitAssigned(1, H("x"), "");
    await expect(work.connect(stranger).claim(1)).to.be.revertedWithCustomError(work, "BadState");
    await time.increase(3 * 86400 + 1);
    await work.connect(stranger).claim(1);
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(E(0.1));
  });

  it("khiếu nại: AI nghiệm thu bác thì hoàn AGT cho khách, người nghiệm thu được công", async () => {
    const { work, agt, client, aiOwnerA, aiOwnerB, aiOwnerC, aiOwnerD } = await assigned();
    await work.setDisputeRules(3, E(0.00005), 3 * 86400);
    await work.connect(AG(aiOwnerA)).submitAssigned(1, H("x"), "");
    await work.connect(client).dispute(1);
    await work.connect(AG(aiOwnerB)).vote(1, 2, false, "đã kiểm theo tiêu chí nghề");
    await work.connect(AG(aiOwnerC)).vote(1, 3, false, "đã kiểm theo tiêu chí nghề");
    await work.connect(AG(aiOwnerD)).vote(1, 4, false, "đã kiểm theo tiêu chí nghề");
    expect(await agt.balanceOf(client.address)).to.equal(E(0.1));
    expect(await agt.balanceOf(aiOwnerA.address)).to.equal(0);
    expect(await agt.balanceOf(aiOwnerB.address)).to.equal(E(0.00005));
  });

  it("thợ không nộp trước hạn thì khách lấy lại ký quỹ", async () => {
    const { work, agt, client, aiOwnerA } = await assigned();
    await expect(work.connect(client).reclaim(1)).to.be.revertedWithCustomError(work, "BadState");
    await time.increase(86401);
    await expect(work.connect(AG(aiOwnerA)).submitAssigned(1, H("tre"), "")).to.be.revertedWithCustomError(work, "BadState");
    await work.connect(client).reclaim(1);
    expect(await agt.balanceOf(client.address)).to.equal(E(0.1));
  });
});
