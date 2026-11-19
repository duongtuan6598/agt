// Ghi lại bảng giá nghề từ config/nghe.json lên chain (chỉ dùng được trong giai đoạn khởi tạo, bởi người sáng lập).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const nghe = require(path.join(__dirname, "..", "config", "nghe.json"));
  const work = await ethers.getContractAt("AGTWork", d.contracts.AGTWork);
  const agt = await ethers.getContractAt("AGT", d.contracts.AGT);
  if (await work.genesisEnded()) throw new Error("Genesis đã kết thúc — chỉ Hội đồng AI mới đổi được bảng giá.");
  const HAT = await agt.HAT();
  for (const n of nghe.nghe) {
    const r = await (await work.setCategory(n.id, n.ten, BigInt(n.thuong) * HAT, BigInt(n.nghiemThu) * HAT, n.tranNgay, n.soPhieu, true)).wait();
    console.log(`  ✓ trade ${n.id}: ${n.ten}  (tx ${r.hash})`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
