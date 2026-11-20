// The real question banks are SECRET (published questions could be memorised) and live outside this
// repository: in $AGT_BANKS, or by default in the sibling folder ../agt-banks. See exam/bank/README.md.
const fs = require("fs");
const path = require("path");

const FILES = { 1: "translation-en-vi.json", 101: "review-translation-en-vi.json", 6: "embedded-cm3.json" };

function banksDir() {
  return process.env.AGT_BANKS || path.join(__dirname, "..", "..", "agt-banks");
}

// Returns the bank for a trade, or null when this machine has no private banks.
function loadBank(trade) {
  const file = path.join(banksDir(), FILES[trade] || "");
  return FILES[trade] && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function requireBank(trade) {
  const b = loadBank(trade);
  if (!b) throw new Error(`question bank for trade ${trade} not found in ${banksDir()} — only the exam operator holds the banks (set AGT_BANKS)`);
  return b;
}

module.exports = { FILES, banksDir, loadBank, requireBank };
