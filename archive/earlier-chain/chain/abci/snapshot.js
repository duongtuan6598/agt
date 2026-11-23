// Snapshot of AGT balances on BSC at one block: the opening balances of AGT's own ledger (a one-time
// snapshot, not a bridge). Rebuilt by anyone from public Transfer events, and the result must match totalSupply.
//   node chain/abci/snapshot.js <token> <fromBlock> [atBlock]   → JSON { snapshot: { token, bscBlock }, balances }
const { ethers } = require("ethers");
const RPC = process.env.BSC_RPC || "https://bsc-testnet-rpc.publicnode.com";

async function snapshot(token, fromBlock, atBlock) {
  const p = new ethers.JsonRpcProvider(RPC);
  const at = atBlock ?? (await p.getBlockNumber()) - 15;
  const t = new ethers.Contract(token, ["event Transfer(address indexed from, address indexed to, uint256 value)", "function totalSupply() view returns (uint256)"], p);
  const bal = {};
  for (let a = fromBlock; a <= at; a += 5000) {
    for (const e of await t.queryFilter(t.filters.Transfer(), a, Math.min(a + 4999, at))) {
      const { from, to, value } = e.args;
      if (from !== ethers.ZeroAddress) bal[from] = (bal[from] || 0n) - value;
      if (to !== ethers.ZeroAddress) bal[to] = (bal[to] || 0n) + value;
    }
  }
  const out = Object.fromEntries(Object.entries(bal).filter(([, v]) => v > 0n).sort().map(([a, v]) => [a, v.toString()]));
  const sum = Object.values(out).reduce((s, v) => s + BigInt(v), 0n);
  const supply = await t.totalSupply({ blockTag: at });
  if (sum !== supply) throw new Error(`snapshot ${sum} ≠ totalSupply ${supply} at block ${at}: scan from an earlier block`);
  return { snapshot: { token: ethers.getAddress(token), bscBlock: at }, balances: out };
}

module.exports = { snapshot };
if (require.main === module) {
  const [token, from, at] = process.argv.slice(2);
  snapshot(token, Number(from), at ? Number(at) : undefined).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exitCode = 1; });
}
