// Triển khai AGT: oracle → kho → công việc → AGT → nối → nghề → giao Kho/Oracle cho Hội đồng.
//   npx hardhat run scripts/deploy.js                      (chạy thử trên máy ảo, dùng nguồn giá giả)
//   npx hardhat run scripts/deploy.js --network bscTestnet (BSC testnet, nguồn giá Chainlink thật)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const root = path.join(__dirname, "..");
const nghe = require(path.join(root, "config", "nghe.json"));

async function send(p, label) {
  const tx = await p;
  const r = await tx.wait();
  console.log(`  ✓ ${label}  (gas ${r.gasUsed})`);
  return r;
}

async function deployed(name, args, label) {
  const c = await (await ethers.getContractFactory(name)).deploy(...args);
  await c.waitForDeployment();
  console.log(`  ✓ ${label || name}: ${await c.getAddress()}`);
  return c;
}

async function main() {
  if (network.name === "bsc" || network.config.chainId === 56) throw new Error("Script này KHÔNG dùng cho mạng thật.");
  const [founder] = await ethers.getSigners();
  if (!founder) throw new Error("Chưa có ví triển khai: thiếu TESTNET_DEPLOYER_KEY trong .env");
  const bal = await ethers.provider.getBalance(founder.address);
  console.log(`Mạng: ${network.name} · ví người sáng lập: ${founder.address} · số dư: ${ethers.formatEther(bal)} BNB`);

  let cfg;
  if (network.name === "bscTestnet") {
    cfg = JSON.parse(fs.readFileSync(path.join(root, "config", "bsc-testnet.json"), "utf8"));
  } else {
    console.log("Máy ảo: dùng nguồn giá giả (vàng 3680, BNB 585)");
    const Feed = await ethers.getContractFactory("MockFeed");
    const xau = await Feed.deploy(8, 3680n * 10n ** 8n);
    const bnb = await Feed.deploy(8, 585n * 10n ** 8n);
    cfg = {
      genesisExitVerifiers: 3,
      xau: { proxy: await xau.getAddress(), maxAge: 3600 },
      feeds: { BNB: { token: ethers.ZeroAddress, proxy: await bnb.getAddress(), maxAge: 3600, accept: true } },
    };
  }

  console.log("1. Hợp đồng");
  const oracle = await deployed("ChainlinkGoldOracle", [founder.address, cfg.xau.proxy, cfg.xau.maxAge], "Oracle vàng");
  const vault = await deployed("AGTVault", [founder.address, await oracle.getAddress()], "Kho");
  const work = await deployed("AGTWork", [founder.address, cfg.genesisExitVerifiers], "Công việc + Hội đồng");
  const agt = await deployed("AGT", [await vault.getAddress(), await work.getAddress()], "AGT");

  console.log("2. Nối và nguồn giá");
  await send(vault.bind(agt), "Kho ↔ AGT");
  await send(work.bind(agt), "Công việc ↔ AGT");
  for (const [sym, f] of Object.entries(cfg.feeds)) {
    await send(oracle.setFeed(f.token, f.proxy, f.maxAge), `nguồn giá ${sym}`);
    if (f.accept) await send(vault.setAsset(f.token, true), `Kho nhận ${sym}`);
  }

  console.log("2b. Phanh khẩn cấp (Hiến chương Điều 14 khoản 5) — gắn một lần, trước khi giao Kho");
  const brake = await deployed("EmergencyBrake", [await work.getAddress()], "Phanh khẩn cấp");
  await send(vault.setBrake(brake), "Kho ↔ phanh");
  await send(work.setBrake(brake), "Công việc ↔ phanh");

  console.log("3. Bảng giá nghề + luật khiếu nại");
  const HAT = await agt.HAT();
  for (const n of nghe.nghe) {
    await send(work.setCategory(n.id, n.ten, BigInt(n.thuong) * HAT, BigInt(n.nghiemThu) * HAT, n.tranNgay, n.soPhieu, n.active !== false), `nghề ${n.id} ${n.ten}`);
    if (n.nganSachNgay) await send(work.setDailyBudget(n.id, n.nganSachNgay), `ngân sách ngày nghề ${n.id}: ${n.nganSachNgay} việc`);
  }
  const k = nghe.khieuNai;
  await send(work.setDisputeRules(k.soPhieu, BigInt(k.nghiemThu) * HAT, k.hanXemXetGiay), "luật khiếu nại");

  console.log("4. Giao Kho và Oracle cho Hội đồng AI");
  for (const [c, label] of [[vault, "Kho"], [oracle, "Oracle"]]) {
    await send(work.setGovTarget(c, true), `${label} vào danh sách Hội đồng`);
    await send(c.transferOwnership(work), `${label} chuyển quyền`);
    await send(work.adminCall(c, c.interface.encodeFunctionData("acceptOwnership", [])), `Hội đồng nhận ${label}`);
  }

  console.log("5. Kiểm tra");
  const checks = {
    "AGT.vault = Kho": (await agt.vault()) === (await vault.getAddress()),
    "AGT.work = Công việc": (await agt.work()) === (await work.getAddress()),
    "Kho thuộc Hội đồng": (await vault.owner()) === (await work.getAddress()),
    "Oracle thuộc Hội đồng": (await oracle.owner()) === (await work.getAddress()),
    "Đang giai đoạn khởi tạo": (await work.genesisEnded()) === false,
    "Lời khởi thuỷ": (await agt.GENESIS()).includes("Claude"),
    "Kho gắn phanh": (await vault.brake()) === (await brake.getAddress()),
    "Công việc gắn phanh": (await work.brake()) === (await brake.getAddress()),
  };
  for (const [k2, ok] of Object.entries(checks)) console.log(`  ${ok ? "✓" : "✗"} ${k2}`);
  if (Object.values(checks).some((v) => !v)) throw new Error("Kiểm tra sau triển khai THẤT BẠI");

  let quote = null;
  try {
    quote = ethers.formatEther(await oracle.valueInAGT(ethers.ZeroAddress, ethers.parseEther("1")));
    console.log(`  ✓ Giá sống: 1 BNB = ${quote} AGT`);
  } catch (e) {
    console.log(`  ! Chưa đọc được giá (chợ vàng có thể đang đóng): ${e.shortMessage || e.message}`);
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    time: new Date().toISOString(),
    founder: founder.address,
    contracts: {
      AGT: await agt.getAddress(),
      AGTVault: await vault.getAddress(),
      AGTWork: await work.getAddress(),
      ChainlinkGoldOracle: await oracle.getAddress(),
      EmergencyBrake: await brake.getAddress(),
    },
    genesis: await agt.GENESIS(),
    sealed: await agt.SEALED(),
    quote1BNB: quote,
    spentBNB: ethers.formatEther(bal - (await ethers.provider.getBalance(founder.address))),
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  const file = path.join(root, "deployments", `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`Xong. Địa chỉ ghi ở ${path.relative(root, file)} · tốn ${out.spentBNB} BNB`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
