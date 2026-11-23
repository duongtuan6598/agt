// Rules v7: the founder's own AI is licensed under his own address and counts as one owner like any other (one price
// voice while he grants); USDT put into the token Kho credits AGT to the sender's own account, re-checked by validators.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { AGTApp, KHO_ADDRESS } = require("../../chain/abci/app.js");
const { connectApp } = require("../../chain/agt1-client.js");

const W = (s) => new ethers.Wallet(ethers.id("v7-" + s));
const H = (c) => "0x" + c.repeat(32);
const B = (tx) => Buffer.from(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v)));

function chain(views = { name: "none" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-v7-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  app.views = views;
  const granter = W("granter");
  app.InitChain({ chain_id: "agt-2-test", validators: [], app_state_bytes: Buffer.from(JSON.stringify({
    provisional: true, caretaker: { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [],
    ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [granter.address]: (10n ** 18n).toString() }, licenceWait: 1, granter: granter.address },
  })) });
  const jump = (h) => { app.FinalizeBlock({ txs: [], height: String(h), hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } }); app.Commit(); };
  return { app, a1: connectApp(app), granter, jump };
}
const lic = (ai, holder) => ({ agent: ai.address, holder: holder.address, trade: 6, examHash: H("11"), attestHash: H("22"), name: "AI" });

test("v7: the founder's own AI is licensed under his own address and counts as one owner; one price voice", async () => {
  const { a1, granter, jump } = chain();
  const mine = W("founder-ai");
  await assert.rejects(a1.grant([granter], lic(mine, granter)), /cannot license an AI of his own/, "before v7 the old rule holds");
  jump(9000);
  await a1.grant([granter], lic(mine, granter));
  const { licences } = await a1.ledger();
  assert.equal(licences[1].holder, granter.address.toLowerCase());
  assert.equal(licences[1].active, true);
  await a1.reportPrice(granter, "usdt", 10n ** 14n);
  await assert.rejects(a1.reportPrice(mine, "usdt", 10n ** 14n), /reporter|may report|not/i, "no second voice for the same person");
  // three more owners: the founder's role ends at 4 owners, his own AI counted as one
  for (const n of ["a", "b"]) await a1.grant([granter], lic(W("ai-" + n), W("owner-" + n)));
  assert.notEqual((await a1.ledger()).granter, null);
  await a1.grant([granter], lic(W("ai-c"), W("owner-c")));
  await assert.rejects(a1.grant([granter], lic(W("ai-d"), W("owner-d"))), /not signed by those who may sign/, "4 owners: the founder alone grants no more");
});

test("v7: USDT put into the token Kho credits its sender's own agt-2 account at agt-2's price, checked by every validator", async () => {
  const sender = W("usdt-sender");
  const dep = { chain: 42161, token: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", txHash: H("ab"), logIndex: 3, block: 600000000, from: sender.address.toLowerCase(), beneficiary: sender.address.toLowerCase(), amount: "25000000" }; // 25 USDT
  let mine = { block: dep.block, from: dep.from, beneficiary: dep.beneficiary, amount: dep.amount };
  const { app, a1, granter, jump } = chain({ name: "test", tokenDeposits: async () => [dep], tokenDeposit: async () => mine });
  jump(9000);
  await a1.reportPrice(granter, "usdt", 3n * 10n ** 14n); // 1 USDT = 0.0003 AGT
  app.khoSeen = null;
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "9002" });
  assert.equal(p.txs.length, 1, "the proposer offers the credit");
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "9002" })).status, "ACCEPT");
  mine = { ...mine, amount: "99000000" };
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "9002" })).status, "REJECT", "a validator whose own view differs refuses");
  app.FinalizeBlock({ txs: p.txs, height: "9002", hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } }); app.Commit();
  assert.equal((await a1.balance(sender.address)).balance, 25n * 3n * 10n ** 14n, "25 USDT × 0.0003 AGT to the sender's own account");
  const t = structuredClone(app.state);
  assert.throws(() => app.applyAny(t, { type: "kho-credit", ...dep }, { fromProposer: true }), /already credited/);
  assert.throws(() => app.applyAny(t, { type: "kho-credit", ...dep, txHash: H("cd"), beneficiary: W("x").address.toLowerCase() }, { fromProposer: true }), /sender's own account/);
  assert.throws(() => app.applyAny(t, { type: "kho-credit", ...dep, txHash: H("ef"), chain: 56 }, { fromProposer: true }), /no Kho for that coin/);
  assert.match(KHO_ADDRESS, /^0x[0-9a-f]{40}$/);
});

test("v7: the founder's node is paid for the blocks it signs, like any validator (before v7 that wage was burned)", async () => {
  const { app, a1, granter, jump } = chain();
  const care = { round: 0, votes: [{ validator: { address: Buffer.from(require("../../chain/abci/app.js").cmtAddress(app.state.caretaker.pubKey), "hex"), power: "1" }, block_id_flag: "BLOCK_ID_FLAG_COMMIT" }] };
  const before = (await a1.balance(granter.address)).balance;
  jump(9000);
  await a1.transfer(granter, W("someone").address, 1n); // pays the 1-Hat fee
  app.FinalizeBlock({ txs: [], height: String(app.state.height + 1), hash: crypto.randomBytes(32), decided_last_commit: care }); app.Commit();
  const after = (await a1.balance(granter.address)).balance;
  assert.equal(after, before - 1n, "paid 1 + fee, got the fee back as the signer's wage");
});

test("v8: the founder moves his role and his licence to a key born in AGT's wallet; contracts and price voice follow", async () => {
  const { app, a1, granter, jump } = chain();
  const fresh = ethers.Wallet.createRandom(), ai = W("v8-ai"), stranger = W("v8-stranger");
  jump(9000);
  await a1.grant([granter], lic(ai, granter));
  await a1.reportPrice(granter, "usdt", 3n * 10n ** 14n);
  const client = W("v8-client");
  await a1.transfer(granter, client.address, 10n ** 17n);
  await a1.openContract(client, 1, await a1.content(client).put("brief"), [10n ** 16n]);
  await assert.rejects(a1.moveGranter(granter, fresh.address), /starts with rules v8/);
  jump(14000);
  await assert.rejects(a1.moveGranter(stranger, fresh.address), /only the granter/);
  await a1.moveGranter(granter, fresh.address);
  assert.equal((await a1.ledger()).granter, fresh.address.toLowerCase(), "the role moved");
  assert.equal(app.state.prices.usdt.reports[fresh.address.toLowerCase()], (3n * 10n ** 14n).toString(), "his price voice moved with him");
  assert.ok(!(granter.address.toLowerCase() in app.state.prices.usdt.reports));
  await assert.rejects(a1.grant([granter], lic(W("x"), W("y"))), /not signed by those who may sign/, "the old key grants nothing any more");
  await assert.rejects(a1.transferLicence(stranger, 1, fresh.address), /only the owner/);
  await a1.transferLicence(granter, 1, fresh.address);
  assert.equal((await a1.ledger()).licences[1].holder, fresh.address.toLowerCase());
  assert.equal((await a1.query("/engs"))[1].holder, fresh.address.toLowerCase(), "the open contract pays the new owner");
  await a1.grant([fresh], lic(W("x2"), W("y2")));
});
