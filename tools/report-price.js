// Report a price on agt-1: AGT per whole coin of an asset, signed by the reporter's key (a licensed AI's key, or the
// starting granter's). The reporter chooses its own sources; the chain takes the median and refuses moves over 10%.
//   KEY=<hex> node tools/report-price.js <asset e.g. 97:native> <AGT per coin, e.g. 0.156> [rpc]
const { ethers } = require("ethers");
const C = require("../chain/core.js");
const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));
(async () => {
  const [asset, agtPerCoin, rpc = "http://127.0.0.1:26657"] = process.argv.slice(2);
  const w = new ethers.Wallet(process.env.KEY);
  const get = async (q) => (await (await fetch(rpc + q)).json()).result;
  const query = async (p) => des(Buffer.from((await get(`/abci_query?path=%22${encodeURIComponent(p)}%22`)).response.value, "base64").toString("utf8"));
  const st = await query("/state");
  const now = await query("/price/" + asset);
  const nonce = Number(now.nonces[w.address.toLowerCase()] || 0);
  const price = ethers.parseEther(agtPerCoin).toString();
  const sig = w.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-PRICE-v1", chainId: st.chainId, asset, price, nonce })));
  const tx = { type: "price-report", asset, price, nonce, reporter: w.address, sig };
  const r = await get(`/broadcast_tx_commit?tx=0x${Buffer.from(JSON.stringify(tx)).toString("hex")}`);
  if (r.check_tx.code || r.tx_result.code) throw new Error(r.check_tx.log || r.tx_result.log);
  const after = await query("/price/" + asset);
  console.log(`reported ${agtPerCoin} AGT per coin of ${asset} in block ${r.height}; agt-1 median now ${ethers.formatEther(after.price)}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
