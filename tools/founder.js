// The founder's key, from AGT's own encrypted wallet file (never a bare key): AGT_FOUNDER_WALLET + AGT_FOUNDER_PASS,
// read from the environment or from .env next to the repository root.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
function env(name) {
  if (process.env[name]) return process.env[name];
  const f = path.join(__dirname, "..", ".env");
  const m = fs.existsSync(f) && fs.readFileSync(f, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
}
async function founderWallet() {
  const file = env("AGT_FOUNDER_WALLET"), pass = env("AGT_FOUNDER_PASS");
  if (!file || !pass) throw new Error("no founder wallet: set AGT_FOUNDER_WALLET and AGT_FOUNDER_PASS");
  return ethers.Wallet.fromEncryptedJson(fs.readFileSync(file, "utf8"), pass);
}
module.exports = { founderWallet, env };
