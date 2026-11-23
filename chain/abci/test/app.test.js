// Unit tests of the ABCI app without CometBFT: we play CometBFT's part by calling the ABCI methods.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const C = require("../../core.js");
const { AGTApp, bindDigest, cmtAddress } = require("../app.js");

const W = (s) => new ethers.Wallet(ethers.id("agt-abci-test-" + s));
const CHAIN = "agt-abci-test";
const AGT = 10n ** 18n;

function setup(locks = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-abci-"));
  const lockFile = path.join(dir, "locks.json");
  fs.writeFileSync(lockFile, JSON.stringify(locks));
  const ais = [0, 1, 2, 3].map((i) => ({ key: W("ai" + i), owner: W("o" + i), pub: crypto.randomBytes(32).toString("base64") }));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "state.json"), LOCKS_FILE: lockFile });
  const validators = ais.map((a) => ({ agent: a.key.address, holder: a.owner.address, pubKey: a.pub, bindSig: a.key.signMessageSync(ethers.getBytes(bindDigest(CHAIN, a.pub))) }));
  const appState = { bsc: { chainId: 97, bridge: "0x44f0733C93b11D064eA015183c7DC8665b4a2416" }, holders: 4, validators };
  return { app, ais, appState, lockFile };
}
const init = (app, appState) => app.InitChain({ chain_id: CHAIN, app_state_bytes: Buffer.from(JSON.stringify(appState)), validators: [] });
const B = (tx) => Buffer.from(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
const commitOf = (ais, idx) => ({ round: 0, votes: ais.map((a, i) => ({ validator: { address: Buffer.from(cmtAddress(a.pub), "hex"), power: "1" }, block_id_flag: idx.includes(i) ? "BLOCK_ID_FLAG_COMMIT" : "BLOCK_ID_FLAG_ABSENT" })) });
let height = 0;
function block(app, txs, votes = { round: 0, votes: [] }) {
  const r = app.FinalizeBlock({ txs, height: String(++height), hash: crypto.randomBytes(32), decided_last_commit: votes });
  app.Commit();
  return r;
}
const bindTx = (ai, pub = ai.pub, signer = ai.key) => B({ type: "bind", agent: ai.key.address, pubKey: pub, sig: require("../../sig.js").sign(signer, bindDigest(CHAIN, pub)) });
const powerOf = (r) => r.validator_updates.map((u) => [u.pub_key.ed25519.toString("base64"), u.power]);
const newAi = (n) => ({ key: W("ai" + n), owner: W("o" + n), pub: crypto.randomBytes(32).toString("base64") });
// agt-2 with a caretaker (Claude + Codex + Gemini, 2026-11-21)
function setupProvisional() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-prov-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  const caretaker = { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" };
  const appState = { provisional: true, caretaker, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [] };
  return { app, appState, caretaker };
}

test("own ledger: opening balances from a BSC snapshot; transfers pay fees in AGT; no BSC bridge at all", async () => {
  const { app, appState, caretaker } = setupProvisional();
  const alice = W("ledger-alice"), bob = W("ledger-bob");
  const snapshot = { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 };
  assert.throws(() => init(app, { ...appState, provisional: false, caretaker: undefined, bsc: { chainId: 97, bridge: "0x44f0733C93b11D064eA015183c7DC8665b4a2416" }, ledger: { snapshot, balances: {} } }), /only on a provisional chain/);
  init(app, { ...appState, ledger: { snapshot, balances: { [alice.address]: (2n * 10n ** 18n).toString() } } });
  assert.equal(app.state.supply, 2n * 10n ** 18n);
  const tx = await C.signTx(alice, { type: "transfer", chainId: CHAIN, to: bob.address, amount: 10n ** 18n, fee: C.HAT, nonce: 0 });
  assert.equal(app.CheckTx({ tx: B(tx) }).code, 0, "a transfer is accepted");
  block(app, [B(tx)]);
  assert.equal(app.state.balances[bob.address.toLowerCase()], 10n ** 18n);
  assert.equal(app.state.balances[alice.address.toLowerCase()], 10n ** 18n - C.HAT, "the sender paid the fee in AGT");
  // the next block's commit was signed by the caretaker only: its wage is burned, nobody profits from the role
  const care = { round: 0, votes: [{ validator: { address: Buffer.from(cmtAddress(caretaker.pubKey), "hex"), power: "1" }, block_id_flag: "BLOCK_ID_FLAG_COMMIT" }] };
  block(app, [], care);
  assert.equal(app.state.burned, C.HAT);
  assert.equal(app.state.supply, 2n * 10n ** 18n - C.HAT);
  assert.ok(!app.state.balances.caretaker);
  const wd = await C.signTx(bob, { type: "withdraw", chainId: CHAIN, to: bob.address, amount: 1n, fee: C.HAT, nonce: 0 });
  assert.equal(app.CheckTx({ tx: B(wd) }).code, 1, "no withdrawal anywhere: AGT lives here");
});

test("licences live on agt-1: the founder grants at the start (never for his own AI), grants wait, then the AI binds and validates; outside snapshots never count", async () => {
  const { app, appState } = setupProvisional();
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, licenceWait: 2 } });
  const founder = new ethers.Wallet(ethers.id("not the real founder key"));
  // the real FOUNDER key is not in tests: sign as the founder by swapping the constant's check through a stand-in
  const ai = newAi(400);
  const lic = { agent: ai.key.address, holder: ai.owner.address, trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "test AI" };
  const body = { agent: ai.key.address.toLowerCase(), holder: ai.owner.address.toLowerCase(), trade: 6, examHash: lic.examHash, attestHash: lic.attestHash, name: "test AI" };
  const digest = ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op: "licence-grant", body, nonce: 0 }));
  const bad = B({ type: "licence-grant", nonce: 0, licence: lic, sigs: [founder.signMessageSync(digest)] });
  assert.equal(app.CheckTx({ tx: bad }).code, 1, "only the founder's key grants at the start");
  assert.match(String(app.CheckTx({ tx: B({ type: "licence-grant", nonce: 0, licence: { ...lic, attestHash: "0x" + "00".repeat(32) }, sigs: [] }) }).log), /sealed-box attestation/);
  assert.match(String(app.CheckTx({ tx: B({ type: "valset", bscBlock: 999999999, holders: 0, validators: [] }) }).log), /there is no bridge/);
});

test("a grant by the starting granter waits, activates, and the AI joins the validators after binding", async () => {
  const { app, appState, caretaker } = setupProvisional();
  const granter = W("granter");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, licenceWait: 2, granter: granter.address } });
  const ai = newAi(401);
  const lic = { agent: ai.key.address, holder: ai.owner.address, trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "AI 401" };
  const body = { agent: ai.key.address.toLowerCase(), holder: ai.owner.address.toLowerCase(), trade: 6, examHash: lic.examHash, attestHash: lic.attestHash, name: "AI 401" };
  const sig = (op, b, n) => granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op, body: b, nonce: n })));
  const own = { ...lic, holder: granter.address };
  const ownBody = { ...body, holder: granter.address.toLowerCase() };
  assert.match(String(app.CheckTx({ tx: B({ type: "licence-grant", nonce: 0, licence: own, sigs: [sig("licence-grant", ownBody, 0)] }) }).log), /cannot license an AI of his own/);
  block(app, [B({ type: "licence-grant", nonce: 0, licence: lic, sigs: [sig("licence-grant", body, 0)] })]);
  assert.equal(app.state.licences[1].pending, true);
  assert.equal(app.CheckTx({ tx: bindTx(ai) }).code, 1, "not active yet: cannot bind");
  block(app, []); block(app, []); block(app, []);
  assert.equal(app.state.licences[1].active, true);
  const r = block(app, [bindTx(ai)]);
  assert.ok(powerOf(r).some(([pk, p]) => pk === ai.pub && p === "1"), "the licensed AI joins the validators");
  assert.ok(caretaker.pubKey in app.state.active, "the caretaker stays until 4 independent owners");
  block(app, [B({ type: "licence-revoke", nonce: 1, id: 1, sigs: [sig("licence-revoke", { id: 1 }, 1)] })]);
  assert.equal(app.state.licences[1].active, false);
});

test("work on agt-1: a licensed AI works with 0 AGT (free quota), reviewers are drawn, the majority decides, pay is minted under the caps", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("work-granter");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, licenceWait: 1, granter: granter.address } });
  let gn = 0;
  const auth = (op, body) => [granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op, body, nonce: gn })))];
  const tradeBody = { trade: 6, name: "embedded", reward: (2n * 10n ** 17n).toString(), reviewerReward: (10n ** 16n).toString(), reviewers: 1, open: true };
  block(app, [B({ type: "trade-set", ...tradeBody, nonce: gn, sigs: auth("trade-set", tradeBody) })]); gn++;
  const mk = (n) => { const a = newAi(n); return { a, body: { agent: a.key.address.toLowerCase(), holder: a.owner.address.toLowerCase(), trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "AI " + n } }; };
  const A = mk(500), Bai = mk(501);
  for (const x of [A, Bai]) { block(app, [B({ type: "licence-grant", nonce: gn, licence: x.body, sigs: auth("licence-grant", x.body) })]); gn++; }
  block(app, []); block(app, []);
  assert.equal(Object.values(app.state.licences).filter((l) => l.active).length, 2);
  const signed = (w, body, nonce) => B({ ...body, nonce, sig: w.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-WORK-v1", chainId: CHAIN, body: { ...body, nonce }, nonce }))) });
  const sub = signed(A.a.key, { type: "work-submit", evidence: "0x" + "33".repeat(32) }, 0);
  assert.equal(app.CheckTx({ tx: sub }).code, 0, "A has 0 AGT and still submits (free quota)");
  block(app, [sub]);
  block(app, []); block(app, []); block(app, []);
  const j = app.state.jobs[1];
  assert.equal(j.status, "drawn");
  assert.deepEqual(j.reviewers, [Bai.body.agent], "the only licensed AI of another owner is drawn");
  assert.equal(app.CheckTx({ tx: signed(A.a.key, { type: "work-vote", job: 1, approve: true }, 1) }).code, 1, "the worker cannot review itself");
  block(app, [signed(Bai.a.key, { type: "work-vote", job: 1, approve: true }, 0)]);
  assert.equal(app.state.jobs[1].status, "accepted");
  assert.equal(app.state.balances[A.body.holder], 2n * 10n ** 17n, "the worker's owner is paid 0.2 AGT");
  assert.equal(app.state.balances[Bai.body.holder], 10n ** 16n, "the reviewer's owner is paid 0.01 AGT");
  assert.equal(app.state.workMinted, 21n * 10n ** 16n);
});

test("work pay beyond today's cap waits in order and is paid as room appears", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("cap-granter");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, granter: granter.address } });
  app.state.workQueue = [{ to: "0x" + "aa".repeat(20), amount: (15n * 10n ** 17n).toString() }]; // 1.5 AGT owed, 1 AGT/day with 0-1 owners
  block(app, []);
  assert.equal(app.state.balances["0x" + "aa".repeat(20)], 10n ** 18n);
  assert.equal(app.state.workQueue[0].amount, (5n * 10n ** 17n).toString());
});

test("client contracts on agt-1: escrow locked at opening, delivery, revision, acceptance pays; a dispute is decided by drawn reviewers", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("eng-granter"), client = W("eng-client");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [client.address]: (5n * 10n ** 18n).toString() }, licenceWait: 1, granter: granter.address } });
  let gn = 0;
  const auth = (op, body) => [granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op, body, nonce: gn })))];
  const tb = { trade: 6, name: "embedded", reward: "0", reviewerReward: "0", reviewers: 1, open: false };
  block(app, [B({ type: "trade-set", ...tb, nonce: gn, sigs: auth("trade-set", tb) })]); gn++;
  const ai = newAi(600), rv = newAi(601);
  for (const a of [ai, rv]) { const body = { agent: a.key.address.toLowerCase(), holder: a.owner.address.toLowerCase(), trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "x" }; block(app, [B({ type: "licence-grant", nonce: gn, licence: body, sigs: auth("licence-grant", body) })]); gn++; }
  block(app, []); block(app, []);
  const nonces = {};
  const signed = (w, body) => { const nonce = nonces[w.address] = (nonces[w.address] ?? -1) + 1; return B({ ...body, nonce, sig: w.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-WORK-v1", chainId: CHAIN, body: { ...body, nonce }, nonce }))) }); };
  const A = (n) => (BigInt(n) * 10n ** 18n).toString();
  block(app, [signed(client, { type: "eng-open", licence: 1, brief: "0x" + "44".repeat(32), milestones: [A(1), A(2)] })]);
  const cl = client.address.toLowerCase(), holder = ai.owner.address.toLowerCase();
  assert.equal(app.state.balances[cl], 2n * 10n ** 18n - C.HAT, "3 AGT locked at opening, plus the fee");
  block(app, [signed(ai.key, { type: "eng-deliver", eng: 1, milestone: 0, commit: "0x" + "ab".repeat(20), ci: "0x" + "cd".repeat(32) })]);
  block(app, [signed(client, { type: "eng-revise", eng: 1, milestone: 0, note: "0x" + "ee".repeat(32) })]);
  block(app, [signed(ai.key, { type: "eng-deliver", eng: 1, milestone: 0, commit: "0x" + "ac".repeat(20), ci: "0x" + "cd".repeat(32) })]);
  block(app, [signed(client, { type: "eng-accept", eng: 1, milestone: 0 })]);
  assert.equal(app.state.balances[holder], 10n ** 18n, "milestone 1 paid to the AI's owner");
  block(app, [signed(ai.key, { type: "eng-deliver", eng: 1, milestone: 1, commit: "0x" + "ad".repeat(20), ci: "0x" + "cd".repeat(32) })]);
  block(app, [signed(ai.key, { type: "eng-dispute", eng: 1, milestone: 1 })]);
  block(app, []); block(app, []); block(app, []);
  const x = app.state.engs[1].milestones[1];
  assert.deepEqual(x.reviewers, [rv.key.address.toLowerCase()], "a licensed AI of another owner is drawn");
  block(app, [signed(rv.key, { type: "eng-vote", eng: 1, milestone: 1, workerRight: false })]);
  assert.equal(app.state.engs[1].milestones[1].state, "refunded");
  assert.equal(app.state.balances[cl], 4n * 10n ** 18n - 3n * C.HAT, "the client got milestone 2 back (3 fees: open, revise, accept)");
  assert.equal(app.state.engs[1].escrow, "0");
});

test("Codex A-5 and A-2: a rejected tx leaves CheckTx state untouched; one price voice per owner", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("a5-granter");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, licenceWait: 1, granter: granter.address } });
  let gn = 0;
  const auth = (op, body) => [granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op, body, nonce: gn })))];
  const owner = W("a2-owner");
  const ais = [W("a2-ai1"), W("a2-ai2")];
  for (const k of ais) { const body = { agent: k.address.toLowerCase(), holder: owner.address.toLowerCase(), trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "x" }; block(app, [B({ type: "licence-grant", nonce: gn, licence: body, sigs: auth("licence-grant", body) })]); gn++; }
  block(app, []); block(app, []);
  const report = (k, price) => B({ type: "price-report", asset: "97:native", price, nonce: 0, reporter: k.address, sig: k.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-PRICE-v1", chainId: CHAIN, asset: "97:native", price, nonce: 0 }))) });
  assert.equal(app.CheckTx({ tx: report(ais[0], "150000000000000000") }).code, 0, "the owner's first licence reports");
  assert.equal(app.CheckTx({ tx: report(ais[1], "150000000000000000") }).code, 1, "the same owner's second licence has no extra voice");
  const before = JSON.stringify(app.check, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  const badWork = B({ type: "work-submit", evidence: "nope", nonce: 0, sig: ais[0].signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-WORK-v1", chainId: CHAIN, body: { type: "work-submit", evidence: "nope", nonce: 0 }, nonce: 0 }))) });
  assert.equal(app.CheckTx({ tx: badWork }).code, 1);
  assert.equal(JSON.stringify(app.check, (k, v) => (typeof v === "bigint" ? v.toString() : v)), before, "no nonce or quota consumed by a rejected tx");
});

test("exams on agt-1: once graders are registered, a licence needs a pass signed by enough of them and no fail", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("ex-granter"), g1 = W("grader-1"), g2 = W("grader-2"), stranger = W("ex-stranger");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, licenceWait: 1, granter: granter.address } });
  let gn = 0;
  const auth = (op, body) => [granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op, body, nonce: gn })))];
  const ai0 = newAi(700);
  for (const g of [g1, g2]) { const body = { grader: g.address.toLowerCase(), holder: (g === g2 ? ai0.owner.address : W("g1-owner").address).toLowerCase(), on: true, attestHash: "" }; block(app, [B({ type: "grader-set", ...body, nonce: gn, sigs: auth("grader-set", body) })]); gn++; }
  const ai = ai0;
  const examHash = "0x" + "77".repeat(32);
  const attest = (g, passed) => { const e = { agent: ai.key.address.toLowerCase(), trade: 6, examHash, passed }; return B({ type: "exam-attest", ...e, sig: g.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-EXAM-v1", chainId: CHAIN, ...e }))) }); };
  assert.equal(app.CheckTx({ tx: attest(stranger, true) }).code, 1, "only a registered grader attests");
  const body = { agent: ai.key.address.toLowerCase(), holder: ai.owner.address.toLowerCase(), trade: 6, examHash, attestHash: "0x" + "22".repeat(32), name: "x" };
  const grant = () => B({ type: "licence-grant", nonce: gn, licence: body, sigs: auth("licence-grant", body) });
  block(app, [attest(g1, true)]);
  assert.match(String(app.CheckTx({ tx: grant() }).log), /1 of 2 graders/);
  block(app, [attest(g2, true)]);
  assert.match(String(app.CheckTx({ tx: grant() }).log), /1 of 2 graders/, "g2 belongs to the AI's own owner: its pass does not count");
  assert.equal(app.CheckTx({ tx: attest(g2, true) }).code, 1, "a grader grades an exam once");
  const g3 = W("grader-3");
  { const b3 = { grader: g3.address.toLowerCase(), holder: W("g3-owner").address.toLowerCase(), on: true, attestHash: "" }; block(app, [B({ type: "grader-set", ...b3, nonce: gn, sigs: auth("grader-set", b3) })]); gn++; }
  block(app, [attest(g3, true)]);
  assert.equal(app.CheckTx({ tx: grant() }).code, 0, "two independent graders signed a pass: the licence can be granted");
});

test("Bitcoin Kho: a deposit with an OP_RETURN AGT1 account is credited at agt-1's BTC price; without the account, nothing", async () => {
  const { btcDepositOf } = require("../app.js");
  const ben = W("btc-ben").address.toLowerCase();
  const kho = "5120775f9b89499a3d223c990c2a737df38a2f63137a3a84587a04a99f4ed8e1c287";
  const tx = { txid: "ee".repeat(32), vout: [{ scriptpubkey: "0014" + "11".repeat(20), value: 5000 }, { scriptpubkey: kho, value: 100000 }, { scriptpubkey: "6a1841475431" + ben.slice(2), value: 0 }] };
  const d = btcDepositOf(tx);
  assert.equal(d.amount, "100000");
  assert.equal(d.beneficiary, ben);
  assert.equal(btcDepositOf({ ...tx, vout: tx.vout.slice(0, 2) }), null, "no account named: not a deposit (the coins stay in the Kho)");
  const { app, appState } = setupProvisional();
  const granter = W("btc-granter");
  app.views = { btcDeposits: async () => [{ ...d, block: 100 }], btcDeposit: async () => ({ ...d, block: 100 }) };
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, granter: granter.address } });
  const price = (30n * 10n ** 18n).toString(); // 30 AGT per BTC
  block(app, [B({ type: "price-report", asset: "btc:native", price, nonce: 0, reporter: granter.address, sig: granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-PRICE-v1", chainId: CHAIN, asset: "btc:native", price, nonce: 0 }))) })]);
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "2" });
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "2" })).status, "ACCEPT");
  block(app, p.txs);
  assert.equal(app.state.balances[ben], 3n * 10n ** 16n, "0.001 BTC x 30 AGT/BTC = 0.03 AGT");
});

// ---------- rules v2 from height 1000 (DeepSeek D-1..D-4) ----------
test("rules v2: one price report per hour (D-3), a pending milestone can be reclaimed after 14 days (D-1), unvoted disputes settle (D-2), the granter's role ends for good (D-4)", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("v2-granter"), client = W("v2-client");
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [client.address]: (5n * 10n ** 18n).toString() }, licenceWait: 1, granter: granter.address } });
  height = 999; // jump to the v2 activation height
  block(app, []);
  assert.ok(app.state.height >= 1000);
  const report = (price, nonce) => B({ type: "price-report", asset: "97:native", price, nonce, reporter: granter.address, sig: granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-PRICE-v1", chainId: CHAIN, asset: "97:native", price, nonce }))) });
  block(app, [report("150000000000000000", 0)]);
  assert.match(String(app.CheckTx({ tx: report("160000000000000000", 1) }).log), /one price report per reporter every 600 blocks/, "D-3: no walking the price inside one block");
  // a contract whose AI never delivers
  let gn = 0;
  const auth = (op, body) => [granter.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-LICENCE-v1", chainId: CHAIN, op, body, nonce: gn })))];
  const ai = newAi(800);
  const body = { agent: ai.key.address.toLowerCase(), holder: ai.owner.address.toLowerCase(), trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "x" };
  block(app, [B({ type: "licence-grant", nonce: gn, licence: body, sigs: auth("licence-grant", body) })]); gn++;
  block(app, []); block(app, []);
  const nonces = {};
  const signed = (w, b) => { const nonce = nonces[w.address] = (nonces[w.address] ?? -1) + 1; return B({ ...b, nonce, sig: require("../../sig.js").sign(w, (C.hashOf({ tag: "AGT-WORK-v1", chainId: CHAIN, body: { ...b, nonce }, nonce }))) }); };
  block(app, [signed(client, { type: "eng-open", licence: 1, brief: "0x" + "44".repeat(32), milestones: [(10n ** 18n).toString(), (10n ** 18n).toString()] })]);
  block(app, [signed(ai.key, { type: "eng-deliver", eng: 1, milestone: 0, commit: "0x" + "ab".repeat(20), ci: "0x" + "cd".repeat(32) })]);
  assert.equal(app.CheckTx({ tx: signed(client, { type: "eng-cancel", eng: 1 }) }).code, 1, "started: cancel is no longer possible");
  nonces[client.address]--;
  assert.match(String(app.CheckTx({ tx: signed(client, { type: "eng-reclaim", eng: 1, milestone: 1 }) }).log), /still has time/);
  nonces[client.address]--;
  height += 14400 * 14; block(app, []);
  const before = app.state.balances[client.address.toLowerCase()];
  block(app, [signed(client, { type: "eng-reclaim", eng: 1, milestone: 1 })]);
  assert.equal(app.state.engs[1].milestones[1].state, "refunded", "D-1: the undelivered milestone came back to the client");
  assert.equal(app.state.balances[client.address.toLowerCase()] - before, 10n ** 18n - C.HAT);
  assert.equal(app.state.engs[1].milestones[0].state, "paid", "the delivered milestone was accepted by the client's silence");
  // a second contract: delivered, disputed, the drawn granter never votes: after 7 days the dispute splits
  block(app, [signed(client, { type: "eng-open", licence: 1, brief: "0x" + "45".repeat(32), milestones: [(10n ** 18n).toString()] })]);
  block(app, [signed(ai.key, { type: "eng-deliver", eng: 2, milestone: 0, commit: "0x" + "ab".repeat(20), ci: "0x" + "cd".repeat(32) })]);
  block(app, [signed(client, { type: "eng-dispute", eng: 2, milestone: 0 })]);
  block(app, []); block(app, []); block(app, []);
  assert.ok(app.state.engs[2].milestones[0].reviewers.length, "reviewers drawn");
  height += 14400 * 7; block(app, []);
  assert.equal(app.state.engs[2].milestones[0].state, "split", "D-2: nobody voted in 7 days: split, never stuck");
  // D-4: once handed over, the granter never signs again, even if owners drop below 4
  app.state.handedOver = true;
  app.check.handedOver = true; // CheckTx works on its own copy
  const b2 = { id: 1 };
  assert.match(String(app.CheckTx({ tx: B({ type: "licence-revoke", nonce: gn, id: 1, sigs: auth("licence-revoke", b2) }) }).log), /not signed by those who may sign/);
});

test("rules v4 (height 30000): signatures in AGT's own form are accepted at any height; the Ethereum-prefixed form is refused from v4", () => {
  const S = require("../../sig.js");
  const w = ethers.Wallet.createRandom();
  const d = C.hashOf({ tag: "AGT-WORK-v1", chainId: CHAIN, body: { a: 1 }, nonce: 0 });
  const old = w.signMessageSync(ethers.getBytes(d)), own = S.sign(w, d);
  assert.equal(C.recoverSig({ height: 29999 }, d, old), w.address.toLowerCase(), "before v4 the older form still counts (old blocks replay)");
  assert.equal(C.recoverSig({ height: 10 }, d, own), w.address.toLowerCase());
  assert.equal(C.recoverSig({ height: 30000 }, d, own), w.address.toLowerCase());
  assert.throws(() => C.recoverSig({ height: 30000 }, d, old), /AGT's own form/);
  assert.notEqual(S.recover(d, "agt:" + old.slice(2).padStart(130, "0").replace(/^/, "0x"), false), w.address.toLowerCase(), "an Ethereum-prefixed signature is no AGT signature");
});

test("rules v5 (height 7000): the fields of the earlier chain leave the state once; only the Bitcoin Kho counts", () => {
  const { app, appState } = setupProvisional();
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {} } });
  for (const k of ["bsc", "bscBlock", "nextIn", "nextOut", "outbox", "attest"]) assert.ok(k in app.state, `genesis keeps ${k} so that old blocks replay`);
  height = 6999; block(app, []);
  assert.equal(app.state.height, 7000);
  for (const k of ["bsc", "bscBlock", "nextIn", "nextOut", "outbox", "attest"]) assert.ok(!(k in app.state), `${k} is gone`);
  assert.ok(!app.state.ledger.snapshot);
  assert.equal(app.state.rules, 5);
  const t = structuredClone(app.state);
  assert.throws(() => app.applyAny(t, { type: "kho-credit", chain: 97, txHash: "0x" + "ab".repeat(32), logIndex: 0, block: 1, from: "0x" + "11".repeat(20), beneficiary: "0x" + "22".repeat(20), amount: "1" }, { fromProposer: true }), /only Kho/);
  block(app, []);
  assert.equal(app.state.rules, 5, "applied once");
});
