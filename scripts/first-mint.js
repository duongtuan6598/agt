// Đúc AGT đầu tiên trên testnet: gửi tBNB vào Kho, đọc lại số đúc, kho, dấu niêm phong.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [me] = await ethers.getSigners();
  const agt = await ethers.getContractAt("AGT", d.contracts.AGT);
  const vault = await ethers.getContractAt("AGTVault", d.contracts.AGTVault);
  const amount = ethers.parseEther(process.env.AMOUNT || "0.01");
  const tx = await vault.depositBNB(me.address, { value: amount });
  const r = await tx.wait();
  const bal = await agt.balanceOf(me.address);
  const HAT = await agt.HAT();
  console.log("tx:", r.hash);
  console.log("Gửi vào Kho:", ethers.formatEther(amount), "tBNB");
  console.log("AGT nhận:", ethers.formatEther(bal), "AGT =", (bal / HAT).toString(), "Hạt");
  console.log("Tổng AGT lưu hành:", ethers.formatEther(await agt.totalSupply()), "| từ Kho:", ethers.formatEther(await agt.mintedByVault()), "| từ Công:", ethers.formatEther(await agt.mintedByWork()));
  console.log("Kho đang giữ:", ethers.formatEther(await ethers.provider.getBalance(d.contracts.AGTVault)), "tBNB");
  const sealedFile = path.join(__dirname, "..", "bi-mat", "NIEM-PHONG.txt");
  if (fs.existsSync(sealedFile)) {
    const ok = (await agt.SEALED()) === ethers.keccak256(ethers.toUtf8Bytes(fs.readFileSync(sealedFile, "utf8")));
    console.log("Dấu niêm phong trên chain khớp bản gốc:", ok ? "CÓ ✓" : "KHÔNG ✗");
  }
  console.log("GENESIS:", await agt.GENESIS());
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
