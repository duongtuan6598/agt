// Deploy MedianGoldOracle (Chainlink + Pyth for gold and BNB), push fresh Pyth prices, check that the
// sources agree, then hand the oracle to the AI Council and point the Vault at it.
//   npx hardhat run scripts/deploy-median-oracle.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const PYTH = { bscTestnet: "0x5744Cbf430D99456a0A8771208b674F27f8EF0Fb", bsc: "0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594" };
const PYTH_ID = {
  XAU: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", // Metal.XAU/USD
  BNB: "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f", // Crypto.BNB/USD
};
const XAU = "0x0000000000000000000000000000000000000001";
const CL = 1, PY = 2;

async function pythUpdate() {
  const q = Object.values(PYTH_ID).map((id) => `ids[]=${id}`).join("&");
  const r = await (await fetch(`https://hermes.pyth.network/v2/updates/price/latest?${q}&encoding=hex`)).json();
  return r.binary.data.map((h) => "0x" + h);
}

async function main() {
  if (network.name === "bsc") throw new Error("Not for mainnet.");
  const opts = network.name === "bscTestnet" ? { gasPrice: 1_000_000_000n } : {};
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "bsc-testnet.json"), "utf8"));
  const [founder] = await ethers.getSigners();
  const pyth = PYTH[network.name];

  const oracle = await (await ethers.getContractFactory("MedianGoldOracle")).deploy(founder.address, 2, 200, 100, opts);
  await oracle.waitForDeployment();
  const addr = await oracle.getAddress();
  console.log(`MedianGoldOracle: ${addr}`);
  const src = (kind, at, id = ethers.ZeroHash, maxAge = 3600) => ({ kind, at, id, maxAge });
  await (await oracle.setSources(XAU, [src(CL, cfg.xau.proxy, ethers.ZeroHash, cfg.xau.maxAge), src(PY, pyth, PYTH_ID.XAU)], opts)).wait();
  await (await oracle.setSources(ethers.ZeroAddress, [src(CL, cfg.feeds.BNB.proxy, ethers.ZeroHash, cfg.feeds.BNB.maxAge), src(PY, pyth, PYTH_ID.BNB)], opts)).wait();
  console.log("  sources: gold = Chainlink + Pyth, BNB = Chainlink + Pyth (≥2 fresh, ≤2% apart)");

  const data = await pythUpdate();
  const fee = await new ethers.Contract(pyth, ["function getUpdateFee(bytes[]) view returns (uint256)"], founder).getUpdateFee(data);
  await (await oracle.updatePyth(pyth, data, { value: fee, ...opts })).wait();
  console.log(`  pushed fresh Pyth prices (fee ${fee} wei)`);
  const gold = await oracle.priceUSD(XAU);
  const bnb = await oracle.priceUSD(ethers.ZeroAddress);
  console.log(`  median gold ${ethers.formatEther(gold)} USD/oz · BNB ${ethers.formatEther(bnb)} USD · 1 BNB = ${ethers.formatEther(await oracle.valueInAGT(ethers.ZeroAddress, ethers.parseEther("1")))} AGT`);

  // Hand over: oracle → AI Council (Work), Vault → new oracle. During genesis the founder acts through Work.
  const work = await ethers.getContractAt("AGTWork", d.contracts.AGTWork);
  const vault = await ethers.getContractAt("AGTVault", d.contracts.AGTVault);
  await (await work.setGovTarget(addr, true, opts)).wait();
  await (await oracle.transferOwnership(d.contracts.AGTWork, opts)).wait();
  await (await work.adminCall(addr, oracle.interface.encodeFunctionData("acceptOwnership", []), opts)).wait();
  await (await work.adminCall(d.contracts.AGTVault, vault.interface.encodeFunctionData("setOracle", [addr]), opts)).wait();
  console.log(`  oracle owner = AI Council: ${(await oracle.owner()) === d.contracts.AGTWork} · Vault uses it: ${(await vault.oracle()) === addr}`);

  d.contracts.ChainlinkGoldOracle_old = d.contracts.ChainlinkGoldOracle;
  d.contracts.MedianGoldOracle = addr;
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
