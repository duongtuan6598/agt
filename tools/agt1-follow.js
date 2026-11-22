// Follow agt-1 and check every block yourself: download the genesis and each block through any agt-1 RPC (the public
// door by default), replay it through the AGT rules on YOUR machine (chain/abci/app.js), and compare your state hash
// with the one the next block commits to. If the caretaker (or anyone) ever produced a block that breaks the rules,
// your replay disagrees and this stops at that height. No key, no BSC, no trust.
//   node tools/agt1-follow.js [rpc] [--to <height>]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AGTApp } = require("../chain/abci/app.js");

const rpc = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "https://agt1-relay.agtcoin.workers.dev/rpc").replace(/\/$/, "");
const toArg = process.argv.indexOf("--to");
const get = async (q) => { const r = await (await fetch(rpc + q)).json(); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result; };

(async () => {
  const g = (await get("/genesis")).genesis;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt1-follow-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "state.json") });
  app.bsc = { head: async () => 0, valsetAt: async () => null, locksFrom: async () => [] }; // replay never reads other chains
  app.InitChain({ chain_id: g.chain_id, app_state_bytes: Buffer.from(JSON.stringify(g.app_state)), validators: [] });
  const tip = Number((await get("/status")).sync_info.latest_block_height);
  const last = toArg > 0 ? Math.min(Number(process.argv[toArg + 1]), tip - 1) : tip - 1;
  console.log(`${g.chain_id}: replaying blocks 1…${last} from ${rpc}`);
  for (let h = 1; h <= last; h++) {
    const b = (await get(`/block?height=${h}`)).block;
    const votes = b.last_commit.signatures.map((x) => ({ validator: { address: Buffer.from(x.validator_address || "", "hex"), power: "1" }, block_id_flag: x.block_id_flag === 2 ? "BLOCK_ID_FLAG_COMMIT" : "BLOCK_ID_FLAG_ABSENT" }));
    const txs = (b.data.txs || []).map((t) => Buffer.from(t, "base64"));
    const hash = Buffer.from((await get(`/block?height=${h}`)).block_id.hash, "hex");
    const r = app.FinalizeBlock({ txs, height: String(h), hash, decided_last_commit: { round: Number(b.last_commit.round || 0), votes }, time: b.header.time });
    app.Commit();
    const next = (await get(`/block?height=${h + 1}`)).block.header.app_hash;
    const mine = Buffer.from(r.app_hash).toString("hex").toUpperCase();
    if (mine !== next) {
      console.log(`✗ block ${h}: my state hash ${mine.slice(0, 16)}… ≠ the chain's ${next.slice(0, 16)}… — the rules were not followed here (or changed without a height)`);
      process.exitCode = 2;
      return;
    }
    if (h % 200 === 0 || h === last) console.log(`✓ ${h} blocks replayed and matched · supply ${app.state.supply} wei · licences ${Object.keys(app.state.licences || {}).length}`);
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
