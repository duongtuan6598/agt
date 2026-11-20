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
