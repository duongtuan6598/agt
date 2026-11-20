// Deploy the long-term work contracts (Engagement, Maintenance) next to AGTWork.
//   npx hardhat run scripts/deploy-engagement.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name === "bsc") throw new Error("Not for mainnet.");
  const opts = network.name === "bscTestnet" ? { gasPrice: 1_000_000_000n } : {};
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const name of ["Engagement", "Maintenance"]) {
    const c = await (await ethers.getContractFactory(name)).deploy(d.contracts.AGTWork, opts);
    await c.waitForDeployment();
    const ok = (await c.work()) === d.contracts.AGTWork && (await c.agt()) === d.contracts.AGT;
    console.log(`${name}: ${c.target} · work/AGT wired: ${ok}`);
    if (!ok) throw new Error(`${name} is not wired to this AGTWork/AGT`);
    d.contracts[name] = c.target;
  }
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
