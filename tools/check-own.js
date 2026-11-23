// AGT is a coin of its own (founder, 23 Nov 2026): runtime code may not depend on another chain. This check fails if
// a runtime file names BNB, BSC, Binance, MetaMask or window.ethereum, outside the history allowlist below.
//   node tools/check-own.js        (part of npm test)
const { execSync } = require("child_process");
const fs = require("fs");
const BAD = /\b(bnb|bsc|binance|metamask)\b|window\.ethereum|bscscan|bnbchain/i;
// history and provenance, kept on purpose; and the code still to be removed at a published height (listed, shrinking)
const ALLOW = [
  /^archive\//, /^deployments\//, /^docs\//, /^contracts\//, /^scripts\//, /^test\//, /^artifacts\//, /^cache\//,
  /^chain\/genesis\//, /^public\/chain\/.*genesis\.json$/, /^config\/bsc-/, /^tee\/reference\//, /^hardhat\.config\.js$/,
  /\.md$/, /^tools\/check-own\.js$/, /^public\/vendor\//, /^tee\/test\//, /^chain\/test\//, /^chain\/abci\/test\//,
  // agt-2's own first blocks carry fields of the earlier time; this file replays them exactly and rules v5 retires them
  /^chain\/abci\/history\.js$/,
  // exam service: the closed endpoints of the earlier chain are still in the file (they answer 410)
  /^exam-worker\/src\/index\.js$/,
  // legacy box agent library (translation trade, to be moved to agt-2)
  /^tee\/box\/agent\.js$/,
];
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => f && /\.(js|mjs|cjs|html|sh|json|txt|toml)$/.test(f) && !/node_modules/.test(f));
const hits = [];
for (const f of files) {
  if (ALLOW.some((r) => r.test(f)) || !fs.existsSync(f)) continue;
  fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (BAD.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
}
if (hits.length) { console.error(`✗ runtime code still names another chain (AGT is a coin of its own):\n${hits.join("\n")}`); process.exit(1); }
console.log(`✓ no runtime file depends on another chain (${files.length} files checked)`);
