// Deploy CharterRegistry (Charter Article 14) with the hash of the Charter in force.
//   npx hardhat run scripts/deploy-charter-registry.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { charterHash } = require("../tee/verify.js");

async function main() {
  if (network.name === "bsc") throw new Error("Not for mainnet.");
  const opts = network.name === "bscTestnet" ? { gasPrice: 1_000_000_000n } : {};
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const h = charterHash();
  const r = await (await ethers.getContractFactory("CharterRegistry")).deploy(d.contracts.AGTWork, h, opts);
  await r.waitForDeployment();
  console.log(`CharterRegistry: ${r.target} · charter in force ${await r.charter()} (matches files: ${(await r.charter()) === h})`);
  d.contracts.CharterRegistry = r.target;
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
