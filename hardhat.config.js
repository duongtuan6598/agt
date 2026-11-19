require("@nomicfoundation/hardhat-toolbox");
const fs = require("fs");
const path = require("path");

// Đọc .env (không commit) — chỉ ví testnet, KHÔNG BAO GIỜ để ví có tiền thật ở đây.
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const key = process.env.TESTNET_DEPLOYER_KEY;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      gasPrice: 1_000_000_000, // 1 gwei — ước lượng tự động ra phí ưu tiên dưới mức tối thiểu 0.1 gwei của testnet
      accounts: key ? [key] : [],
    },
  },
};
