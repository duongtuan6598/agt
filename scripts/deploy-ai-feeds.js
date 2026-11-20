// Deploy the AI-council price feeds (gold, BNB) and add them as sources of the MedianGoldOracle.
//   npx hardhat run scripts/deploy-ai-feeds.js --network bscTestnet
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name === "bsc") throw new Error("Not for mainnet.");
  const opts = network.name === "bscTestnet" ? { gasPrice: 1_000_000_000n } : {};
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "bsc-testnet.json"), "utf8"));
  const F = await ethers.getContractFactory("AICouncilPriceFeed");
  const xau = await F.deploy(d.contracts.AGTWork, "XAU / USD", 8, opts);
  const bnb = await F.deploy(d.contracts.AGTWork, "BNB / USD", 8, opts);
  await xau.waitForDeployment();
  await bnb.waitForDeployment();
  console.log(`AI price feeds: XAU ${xau.target} · BNB ${bnb.target}`);
  if (!d.contracts.MedianGoldOracle) {
    // Founder-owned for now; NOT yet used by the Vault (see AUDIT F-3).
    const [founder] = await ethers.getSigners();
    const m = await (await ethers.getContractFactory("MedianGoldOracle")).deploy(founder.address, 2, 200, 100, opts);
    await m.waitForDeployment();
    d.contracts.MedianGoldOracle = m.target;
    d._note_median = "MedianGoldOracle deployed, owned by the founder, NOT yet used by the Vault (Vault still on ChainlinkGoldOracle)";
    console.log(`MedianGoldOracle: ${m.target}`);
  }
  const oracle = await ethers.getContractAt("MedianGoldOracle", d.contracts.MedianGoldOracle);
  const PYTH = "0x5744Cbf430D99456a0A8771208b674F27f8EF0Fb";
  const src = (kind, at, id = ethers.ZeroHash, maxAge = 3600) => ({ kind, at, id, maxAge });
  await (await oracle.setSources("0x0000000000000000000000000000000000000001", [
    src(1, cfg.xau.proxy, ethers.ZeroHash, cfg.xau.maxAge), src(1, xau.target, ethers.ZeroHash, 1800),
    src(2, PYTH, "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2"),
  ], opts)).wait();
  await (await oracle.setSources(ethers.ZeroAddress, [
    src(1, cfg.feeds.BNB.proxy, ethers.ZeroHash, cfg.feeds.BNB.maxAge), src(1, bnb.target, ethers.ZeroHash, 1800),
    src(2, PYTH, "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f"),
  ], opts)).wait();
  console.log("  MedianGoldOracle sources: Chainlink + AI council (+ Pyth when someone pushes it)");
  d.contracts.AICouncilFeedXAU = xau.target;
  d.contracts.AICouncilFeedBNB = bnb.target;
  d.contracts.MedianGoldOracle = d.contracts.MedianGoldOracle;
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
