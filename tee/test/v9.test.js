// Rules v9 (founder: "kho phải chứa được nhiều loại coin"): from V9_AT the token Kho takes USDC too, and has a door on
// chain 56 (BEP-20). A door is only a way in; before its height a deposit through it waits, nothing is lost.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { AGTApp, KHO_TOKENS } = require("../../chain/abci/app.js");
const { connectApp } = require("../../chain/agt1-client.js");

const W = (s) => new ethers.Wallet(ethers.id("v9-" + s));
const H = (c) => "0x" + c.repeat(32);

test("v9: USDT and USDC through the chain-56 door and USDC on the other chains credit their sender, from V9_AT only", async () => {
  const sender = W("sender");
  const from = sender.address.toLowerCase();
  const deps = [
    { chain: 56, token: "0x55d398326f99059ff775485246999027b3197955", txHash: H("a1"), logIndex: 0, block: 135500000, from, beneficiary: from, amount: (10n * 10n ** 18n).toString() }, // 10 USDT, 18 decimals
    { chain: 42161, token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", txHash: H("a2"), logIndex: 1, block: 527100000, from, beneficiary: from, amount: "5000000" }, // 5 USDC, 6 decimals
  ];
  const views = { name: "test", tokenDeposits: async () => deps, tokenDeposit: async (tx) => { const d = deps.find((x) => x.txHash === tx.txHash); return d && { block: d.block, from: d.from, beneficiary: d.beneficiary, amount: d.amount }; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-v9-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  app.views = views;
  const granter = W("granter");
  app.InitChain({ chain_id: "agt-2-test", validators: [], app_state_bytes: Buffer.from(JSON.stringify({
    provisional: true, caretaker: { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [],
    ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [granter.address]: (10n ** 18n).toString() }, licenceWait: 1, granter: granter.address },
  })) });
  const a1 = connectApp(app);
  const jump = (h) => { app.FinalizeBlock({ txs: [], height: String(h), hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } }); app.Commit(); };
  jump(20000);
  await a1.reportPrice(granter, "usdt", 3n * 10n ** 14n);
  await assert.rejects(a1.reportPrice(granter, "usdc", 3n * 10n ** 14n), /bad asset/, "no USDC price before v9");
  assert.throws(() => app.applyAny(structuredClone(app.state), { type: "kho-credit", ...deps[0] }, { fromProposer: true }), /no Kho for that coin/, "the chain-56 door opens at V9_AT");
  app.khoSeen = null;
  assert.equal((await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "20002" })).txs.length, 0, "before v9 the deposits wait");
  jump(22500);
  await a1.reportPrice(granter, "usdc", 3n * 10n ** 14n);
  app.khoSeen = null;
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "22502" });
  assert.equal(p.txs.length, 2);
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "22502" })).status, "ACCEPT");
  app.FinalizeBlock({ txs: p.txs, height: "22502", hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } }); app.Commit();
  assert.equal((await a1.balance(sender.address)).balance, 15n * 3n * 10n ** 14n, "10 USDT (18 decimals) + 5 USDC (6 decimals), each × 0.0003 AGT");
  assert.equal(new Set(Object.values(KHO_TOKENS).map((k) => k.asset)).size, 2);
});
