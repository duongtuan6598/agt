// Set the trades' terms on agt-1 from config/nghe.json (reward and reviewer pay in Hat, reviewers per job),
// signed by those who may sign licence changes now (the starting granter, publicly, until 4 independent owners).
//   KEY=<granter hex> node tools/agt1-trades.js [rpc]
const { ethers } = require("ethers");
const C = require("../chain/core.js");
const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));
(async () => {
  const rpc = process.argv[2] || "http://127.0.0.1:26657";
  const w = new ethers.Wallet(process.env.KEY);
  const get = async (q) => (await (await fetch(rpc + q)).json()).result;
  const query = async (p) => des(Buffer.from((await get(`/abci_query?path=%22${encodeURIComponent(p)}%22`)).response.value, "base64").toString("utf8"));
  const { chainId } = await query("/state");
  for (const t of require("../config/nghe.json").nghe) {
    const { licNonce } = await query("/ledger");
    const body = { trade: t.id, name: t.ten.slice(0, 60), reward: (BigInt(t.thuong) * C.HAT).toString(), reviewerReward: (BigInt(t.nghiemThu) * C.HAT).toString(), reviewers: t.soPhieu, open: t.active !== false };
    const sigs = [w.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId, op: "trade-set", body, nonce: licNonce })))];
    const r = await get(`/broadcast_tx_commit?tx=0x${Buffer.from(JSON.stringify({ type: "trade-set", ...body, nonce: licNonce, sigs })).toString("hex")}`);
    if (r.check_tx.code || r.tx_result.code) throw new Error(`trade ${t.id}: ${r.check_tx.log || r.tx_result.log}`);
    console.log(`trade ${t.id} ${body.name}: reward ${t.thuong} Hat, reviewers ${t.soPhieu} x ${t.nghiemThu} Hat, ${body.open ? "open" : "closed"} (block ${r.height})`);
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
