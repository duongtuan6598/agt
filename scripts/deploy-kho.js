// Deploy the AGT Kho (contracts/KeylessVault.sol) at a deterministic address: CREATE2 through the standard
// deterministic deployer (0x4e59…956c, on most EVM chains) with the public salt keccak256("AGT-KHO-v1").
// Same code + same salt → the same address on every EVM chain, and anyone can recompute it.
//   npx hardhat run scripts/deploy-kho.js --network bscTestnet
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const SALT = ethers.id("AGT-KHO-v1");

async function main() {
  const [me] = await ethers.getSigners();
  const init = (await ethers.getContractFactory("KeylessVault")).bytecode;
  const addr = ethers.getCreate2Address(DEPLOYER, SALT, ethers.keccak256(init));
  if ((await ethers.provider.getCode(addr)) === "0x") {
    const tx = await me.sendTransaction({ to: DEPLOYER, data: ethers.concat([SALT, init]) });
    await tx.wait();
    console.log("deployed, tx", tx.hash);
  } else console.log("already deployed");
  const code = await ethers.provider.getCode(addr);
  if (code === "0x") throw new Error("deployment failed");
  const out = { chainId: Number((await ethers.provider.getNetwork()).chainId), kho: addr, salt: SALT, saltText: "AGT-KHO-v1", deployer: DEPLOYER, initCodeHash: ethers.keccak256(init), runtimeHash: ethers.keccak256(code), block: await ethers.provider.getBlockNumber() };
  const f = path.join(__dirname, "..", "deployments", `kho-${network.name}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2) + "\n");
  console.log(`Kho on ${network.name}: ${addr} · runtime ${out.runtimeHash.slice(0, 18)}… · written to ${path.basename(f)}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
