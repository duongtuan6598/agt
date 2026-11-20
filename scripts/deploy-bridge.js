// Deploy AGTBridge (stage 2 lockbox) next to an existing deployment. No owner, nothing to configure.
//   npx hardhat run scripts/deploy-bridge.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name === "bsc" || network.config.chainId === 56) throw new Error("Not for mainnet.");
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (d.contracts.AGTBridge) throw new Error(`AGTBridge already deployed: ${d.contracts.AGTBridge}`);
  const bridge = await (await ethers.getContractFactory("AGTBridge")).deploy(d.contracts.AGT, d.contracts.AGTWork);
  await bridge.waitForDeployment();
  const addr = await bridge.getAddress();
  const work = await ethers.getContractAt("AGTWork", d.contracts.AGTWork);
  console.log(`AGTBridge: ${addr}`);
  console.log(`  agt  = ${await bridge.agt()}  ${(await bridge.agt()) === d.contracts.AGT ? "✓" : "✗"}`);
  console.log(`  work = ${await bridge.work()}  ${(await bridge.work()) === d.contracts.AGTWork ? "✓" : "✗"}`);
  console.log(`  open = ${await work.genesisEnded()} (opens by itself when genesis ends)`);
  d.contracts.AGTBridge = addr;
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
