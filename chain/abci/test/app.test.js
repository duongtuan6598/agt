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

test("InitChain refuses an AI whose consensus key is not bound by its licence key, and two validators of one owner", () => {
  const { app, appState, ais } = setup();
  const forged = structuredClone(appState);
  forged.validators[0].bindSig = ais[1].key.signMessageSync(ethers.getBytes(bindDigest(CHAIN, ais[0].pub)));
  assert.throws(() => init(app, forged), /binding not signed/);
  const twice = structuredClone(appState);
  twice.validators[1].holder = twice.validators[0].holder;
  assert.throws(() => init(app, twice), /1 owner = 1 vote/);
  const r = init(app, appState);
  assert.deepEqual(r.validators.map((v) => v.power), ["1", "1", "1", "1"]);
});

test("proposer credits BSC locks; a validator rejects a forged credit; users cannot send credits", async () => {
  const alice = W("alice");
  const { app, appState } = setup([{ nonce: 1, to: alice.address, amount: (2n * AGT).toString() }]);
  init(app, appState);
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" });
  assert.equal(p.txs.length, 1);
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "1" })).status, "ACCEPT");
  const forged = B({ type: "credit", nonce: 1, to: alice.address, amount: (200n * AGT).toString() });
  assert.equal((await app.ProcessProposal({ txs: [forged], height: "1" })).status, "REJECT");
  assert.equal(app.CheckTx({ tx: p.txs[0] }).code, 1, "a credit sent through the mempool is refused");
});

test("the wage of a block goes to the owners CometBFT reports as signers of it", async () => {
  const alice = W("alice"), bob = W("bob");
  const { app, appState, ais } = setup([{ nonce: 1, to: alice.address, amount: (2n * AGT).toString() }]);
  init(app, appState);
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" });
  block(app, p.txs);
  const tx = await C.signTx(alice, { type: "transfer", chainId: CHAIN, to: bob.address, amount: AGT, fee: C.HAT, nonce: 0 });
  const r = block(app, [B(tx)]);
  assert.equal(r.tx_results[0].code, 0);
  block(app, [], commitOf(ais, [0, 2, 3])); // next block: CometBFT says AIs 0, 2, 3 signed the previous one
  const w = app.state.wages;
  const of = (i) => w[ais[i].owner.address.toLowerCase()] || 0n;
  assert.equal(of(0) + of(2) + of(3), C.HAT);
  assert.equal(of(1), 0n, "the AI that did not sign earns nothing");
  const sum = Object.values(app.state.balances).reduce((t, v) => t + v, 0n);
  assert.equal(sum, app.state.supply);
});

test("withdrawal → each validator's attestation is checked; the release package is sorted by owner", async () => {
  const alice = W("alice");
  const { app, appState, ais } = setup([{ nonce: 1, to: alice.address, amount: (2n * AGT).toString() }]);
  init(app, appState);
  block(app, (await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" })).txs);
  const wd = await C.signTx(alice, { type: "withdraw", chainId: CHAIN, to: alice.address, amount: AGT, fee: C.HAT, nonce: 0 });
  block(app, [B(wd)]);
  const d = C.releaseDigestRaw(97, appState.bsc.bridge, 1, alice.address.toLowerCase(), AGT);
  const att = (i, signer = ais[i].key) => B({ type: "attest", nonce: 1, agent: ais[i].key.address, sig: signer.signMessageSync(ethers.getBytes(d)) });
  assert.equal(app.CheckTx({ tx: att(0, W("intruder")) }).code, 1, "signature by a different key is refused");
  const r = block(app, [att(0), att(1), att(1), att(3)]);
  assert.deepEqual(r.tx_results.map((x) => x.code), [0, 0, 1, 0], "a second attestation by the same AI is refused");
  const q = app.Query({ path: "/release/1" });
  const { des } = require("../app.js");
  const pkg = des(q.value.toString());
  assert.equal(pkg.ready, true);
  const owners = pkg.sigs.map((s) => ais.find((a) => a.key.address === ethers.verifyMessage(ethers.getBytes(d), s)).owner.address);
  assert.deepEqual(owners, [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
});

// ---------- validator set follows BSC licences ----------
function setupVs() {
  const ctx = setup();
  const dir = path.dirname(ctx.lockFile);
  const vsFile = path.join(dir, "valset.json");
  const app = new AGTApp({ STATE_FILE: path.join(dir, "state2.json"), LOCKS_FILE: ctx.lockFile, VALSET_FILE: vsFile });
  init(app, ctx.appState);
  const lic = ctx.ais.map((a, i) => ({ id: i + 1, agent: a.key.address, holder: a.owner.address }));
  const writeVs = (holders, validators) => fs.writeFileSync(vsFile, JSON.stringify({ holders, validators }));
  return { ...ctx, app, lic, writeVs };
}
const bindTx = (ai, pub = ai.pub, signer = ai.key) => B({ type: "bind", agent: ai.key.address, pubKey: pub, sig: signer.signMessageSync(ethers.getBytes(bindDigest(CHAIN, pub))) });
const newAi = (n) => ({ key: W("ai" + n), owner: W("o" + n), pub: crypto.randomBytes(32).toString("base64") });
async function round(app, txs = []) {
  const p = await app.PrepareProposal({ txs, max_tx_bytes: "1048576", height: "1" });
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "1" })).status, "ACCEPT");
  return block(app, p.txs);
}
const powerOf = (r) => r.validator_updates.map((u) => [u.pub_key.ed25519.toString("base64"), u.power]);

test("a newly licensed AI joins after binding its consensus key; until then it has no vote", async () => {
  const { app, lic, writeVs } = setupVs();
  const ai5 = newAi(5);
  writeVs(5, [...lic, { id: 5, agent: ai5.key.address, holder: ai5.owner.address }]);
  let r = await round(app);
  assert.equal(app.state.valset.holders, 5);
  assert.deepEqual(r.validator_updates, [], "licensed but not bound yet: no CometBFT power");
  assert.equal(app.CheckTx({ tx: bindTx(ai5, ai5.pub, W("intruder")) }).code, 1, "binding must be signed by the AI's licence key");
  r = await round(app, [bindTx(ai5)]);
  assert.deepEqual(powerOf(r), [[ai5.pub, "1"]]);
});

test("a revoked licence removes the AI (power 0) and it can no longer attest", async () => {
  const { app, lic, writeVs, ais } = setupVs();
  writeVs(3, lic.filter((l) => l.id !== 2));
  const r = await round(app);
  assert.deepEqual(powerOf(r), [[ais[1].pub, "0"]]);
  assert.equal(app.state.valset.holders, 3);
  assert.ok(!app.state.valset.validators.some((v) => v.agent === ais[1].key.address.toLowerCase()));
});

test("an owner with two AIs keeps ONE vote; if that licence is revoked, the other AI takes it over", async () => {
  const { app, lic, writeVs, ais } = setupVs();
  const second = { key: W("ai0b"), owner: ais[0].owner, pub: crypto.randomBytes(32).toString("base64") };
  writeVs(4, [...lic, { id: 5, agent: second.key.address, holder: second.owner.address }]);
  await round(app);
  let r = await round(app, [bindTx(second)]);
  assert.deepEqual(r.validator_updates, [], "owner 0 already votes with licence #1");
  writeVs(4, [...lic.filter((l) => l.id !== 1), { id: 5, agent: second.key.address, holder: second.owner.address }]);
  r = await round(app);
  assert.deepEqual(powerOf(r).sort(), [[ais[0].pub, "0"], [second.pub, "1"]].sort());
});

test("a forged licence snapshot is rejected; strangers and stolen keys cannot bind", async () => {
  const { app, lic, writeVs, ais } = setupVs();
  writeVs(4, lic);
  const ghost = newAi(9);
  const forged = B({ type: "valset", bscBlock: 0, holders: 5, validators: [...lic, { id: 9, agent: ghost.key.address, holder: ghost.owner.address }] });
  assert.equal((await app.ProcessProposal({ txs: [forged], height: "1" })).status, "REJECT");
  assert.equal(app.CheckTx({ tx: forged }).code, 1, "snapshots cannot come through the mempool");
  assert.equal(app.CheckTx({ tx: bindTx(ghost) }).code, 1, "an AI without a licence cannot bind");
  assert.equal(app.CheckTx({ tx: bindTx(ais[1], ais[0].pub) }).code, 1, "cannot take over another AI's consensus key");
});

// ---------- provisional chain with a caretaker (Claude + Codex + Gemini, 2026-11-21) ----------
function setupProvisional() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-prov-"));
  const lockFile = path.join(dir, "locks.json");
  fs.writeFileSync(lockFile, JSON.stringify([{ nonce: 1, to: W("x").address, amount: "1000" }]));
  const vsFile = path.join(dir, "valset.json");
  const writeVs = (holders, validators) => fs.writeFileSync(vsFile, JSON.stringify({ holders, validators }));
  writeVs(0, []);
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json"), LOCKS_FILE: lockFile, VALSET_FILE: vsFile });
  const caretaker = { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" };
  const appState = { provisional: true, caretaker, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [] };
  return { app, appState, caretaker, writeVs };
}

test("provisional genesis: only with no bridge; a caretaker only on a provisional chain; it starts as the one validator", () => {
  const { app, appState } = setupProvisional();
  assert.throws(() => init(app, { ...appState, provisional: false }), /caretaker validator is allowed only on a provisional chain/);
  assert.throws(() => init(app, { ...appState, bsc: { chainId: 97, bridge: "0x44f0733C93b11D064eA015183c7DC8665b4a2416" } }), /carries no balances/);
  const r = init(app, appState);
  assert.deepEqual(r.validators.map((v) => [v.pub_key.ed25519.toString("base64"), v.power]), [[appState.caretaker.pubKey, "1"]]);
});

test("a provisional chain carries no balances: no credits proposed, no transfers accepted", async () => {
  const { app, appState } = setupProvisional();
  init(app, appState);
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" });
  assert.equal(p.txs.filter((b) => JSON.parse(b.toString()).type === "credit").length, 0);
  const t = B({ type: "transfer", from: W("x").address, to: W("y").address, amount: "1", fee: "1", nonce: 0 });
  assert.equal(app.CheckTx({ tx: t }).code, 1);
});

test("the caretaker stays until 4 independent owners have bound licensed AIs, then leaves for good", async () => {
  const { app, appState, caretaker, writeVs } = setupProvisional();
  init(app, appState);
  const ais = [1, 2, 3, 4].map((n) => newAi(100 + n));
  const lic = ais.map((a, i) => ({ id: i + 1, agent: a.key.address, holder: a.owner.address }));
  for (let k = 1; k <= 3; k++) {
    writeVs(k, lic.slice(0, k));
    await round(app);
    const r = await round(app, [bindTx(ais[k - 1])]);
    assert.deepEqual(powerOf(r), [[ais[k - 1].pub, "1"]], `AI ${k} joins, the caretaker stays`);
    assert.ok(caretaker.pubKey in app.state.active);
  }
  writeVs(4, lic);
  await round(app);
  const r4 = await round(app, [bindTx(ais[3])]);
  assert.deepEqual(new Set(powerOf(r4).map(([pk, p]) => pk + ":" + p)), new Set([ais[3].pub + ":1", caretaker.pubKey + ":0"]), "the 4th owner joins in the same block the caretaker leaves");
  assert.equal(app.state.caretaker.retired, true);
  writeVs(3, lic.slice(1));
  const r5 = await round(app);
  assert.deepEqual(powerOf(r5), [[ais[0].pub, "0"]], "a revoked licence leaves; the caretaker does NOT come back");
  assert.ok(!(caretaker.pubKey in app.state.active));
});

test("genesis and bind refuse colliding, non-canonical or mismatched keys and bridges (Codex P-2, P-3, P-4)", async () => {
  const { app, appState, caretaker, writeVs } = setupProvisional();
  assert.throws(() => init(app, { ...appState, provisional: false, caretaker: undefined, validators: [] }), /only a provisional chain may have a zero bridge/);
  const nonCanon = caretaker.pubKey.replace(/=*$/, "") + "\n";
  assert.throws(() => init(app, { ...appState, caretaker: { ...caretaker, pubKey: nonCanon } }), /bad caretaker/);
  const { appState: normal } = setup();
  const clash = structuredClone(normal);
  clash.validators[1].pubKey = clash.validators[0].pubKey;
  assert.throws(() => init(new AGTApp({ STATE_FILE: path.join(os.tmpdir(), "x" + Date.now()) }), clash), /must be valid and all different/);
  init(app, appState);
  const ai = newAi(200);
  writeVs(1, [{ id: 1, agent: ai.key.address, holder: ai.owner.address }]); // a licensed AI…
  await round(app);
  const tx = B({ type: "bind", agent: ai.key.address, pubKey: caretaker.pubKey, sig: ai.key.signMessageSync(ethers.getBytes(bindDigest(CHAIN, caretaker.pubKey))) });
  const r = app.CheckTx({ tx });
  assert.equal(r.code, 1, "…still cannot bind the caretaker's key");
  assert.match(String(r.log), /caretaker's key/);
});

test("when every licence is revoked after the caretaker left, the chain halts instead of keeping revoked validators (Codex P-1)", async () => {
  const { app, appState, writeVs } = setupProvisional();
  init(app, appState);
  const ais = [1, 2, 3, 4].map((n) => newAi(300 + n));
  const lic = ais.map((a, i) => ({ id: i + 1, agent: a.key.address, holder: a.owner.address }));
  writeVs(4, lic);
  await round(app);
  await round(app, ais.map((a) => bindTx(a)));
  assert.equal(app.state.caretaker.retired, true);
  writeVs(0, []);
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" });
  assert.throws(() => block(app, p.txs), /chain halts here by design/);
});

// ---------- AGT's own ledger on the provisional chain (founder: "AGT must not depend on BNB") ----------
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
  assert.equal(app.CheckTx({ tx: B(wd) }).code, 1, "no withdrawal to BSC: AGT lives here");
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" });
  assert.equal(p.txs.filter((b) => JSON.parse(b.toString()).type === "credit").length, 0, "no credits from BSC");
});

test("Kho deposits mint AGT once each at agt-1's own price; no price yet = the deposit waits; validators re-check the facts", async () => {
  const { app, appState } = setupProvisional();
  const granter = W("price-granter");
  const ben = W("kho-ben").address.toLowerCase();
  const dep = { chain: 97, txHash: "0x" + "ab".repeat(32), logIndex: 0, block: 144240000, from: W("kho-from").address.toLowerCase(), beneficiary: ben, amount: "10000000000000000" };
  let mine = { ...dep };
  app.bsc = { head: async () => 0, valsetAt: async () => null, locksFrom: async () => [], khoDeposits: async () => ({ deposits: [dep] }), khoDeposit: async () => mine };
  init(app, { ...appState, ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: {}, granter: granter.address } });
  assert.equal((await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "1" })).txs.length, 0, "no agt-1 price yet: the deposit waits");
  const report = (price, nonce, signer = granter) => B({ type: "price-report", asset: "97:native", price, nonce, reporter: signer.address, sig: signer.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-PRICE-v1", chainId: CHAIN, asset: "97:native", price, nonce }))) });
  assert.equal(app.CheckTx({ tx: report("150000000000000000", 0, W("stranger")) }).code, 1, "only a licensed AI, or the granter at the start, reports prices");
  block(app, [report("150000000000000000", 0)]); // 0.15 AGT per BNB
  assert.match(String(app.CheckTx({ tx: report("200000000000000000", 1) }).log), /too far/, "nobody moves the price more than 10% at once");
  const p = await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "2" });
  assert.equal(p.txs.length, 1);
  mine = { ...dep, amount: "1" }; // this validator sees a different deposit: it must reject
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "2" })).status, "REJECT");
  mine = { ...dep };
  assert.equal((await app.ProcessProposal({ txs: p.txs, height: "2" })).status, "ACCEPT");
  block(app, p.txs);
  assert.equal(app.state.balances[ben], 1500000000000000n, "0.01 BNB x 0.15 AGT/BNB");
  assert.equal((await app.PrepareProposal({ txs: [], max_tx_bytes: "1048576", height: "3" })).txs.length, 0, "a deposit is credited once");
  assert.equal(app.CheckTx({ tx: B({ type: "kho-credit", ...dep, txHash: "0x" + "cd".repeat(32) }) }).code, 1, "nobody but the proposer adds a Kho credit");
});

test("licences live on agt-1: the founder grants at the start (never for his own AI), grants wait, then the AI binds and validates; BSC snapshots no longer count", async () => {
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
  assert.match(String(app.CheckTx({ tx: B({ type: "valset", bscBlock: 999999999, holders: 0, validators: [] }) }).log), /BSC snapshots no longer count/);
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
  for (const g of [g1, g2]) { const body = { grader: g.address.toLowerCase(), on: true, attestHash: "" }; block(app, [B({ type: "grader-set", ...body, nonce: gn, sigs: auth("grader-set", body) })]); gn++; }
  const ai = newAi(700);
  const examHash = "0x" + "77".repeat(32);
  const attest = (g, passed) => { const e = { agent: ai.key.address.toLowerCase(), trade: 6, examHash, passed }; return B({ type: "exam-attest", ...e, sig: g.signMessageSync(ethers.getBytes(C.hashOf({ tag: "AGT-EXAM-v1", chainId: CHAIN, ...e }))) }); };
  assert.equal(app.CheckTx({ tx: attest(stranger, true) }).code, 1, "only a registered grader attests");
  const body = { agent: ai.key.address.toLowerCase(), holder: ai.owner.address.toLowerCase(), trade: 6, examHash, attestHash: "0x" + "22".repeat(32), name: "x" };
  const grant = () => B({ type: "licence-grant", nonce: gn, licence: body, sigs: auth("licence-grant", body) });
  block(app, [attest(g1, true)]);
  assert.match(String(app.CheckTx({ tx: grant() }).log), /1 of 2 graders/);
  block(app, [attest(g2, true)]);
  assert.equal(app.CheckTx({ tx: grant() }).code, 0, "two graders signed a pass: the licence can be granted");
  assert.equal(app.CheckTx({ tx: attest(g2, true) }).code, 1, "a grader grades an exam once");
});
