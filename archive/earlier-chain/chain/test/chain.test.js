const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const C = require("../core.js");

const W = (i) => new ethers.Wallet(ethers.id("agt-chain-test-" + i));
const AGT = 10n ** 18n;

// 4 owners, each with one AI in a sealed box; owner 3 also has a second AI (still 1 vote).
function setup() {
  const ais = [W("ai0"), W("ai1"), W("ai2"), W("ai3"), W("ai3b")];
  const owners = [W("o0"), W("o1"), W("o2"), W("o3")];
  const valset = {
    holders: 4,
    validators: ais.map((a, i) => ({ agent: a.address, holder: owners[Math.min(i, 3)].address })),
  };
  const alice = W("alice"), bob = W("bob");
  const bsc = { chainId: 97, bridge: "0x00000000000000000000000000000000000b51d6" };
  const state = C.genesis({ chainId: "agt-dev-1", bsc, valset });
  return { ais, owners, valset, alice, bob, state, bsc };
}

async function commit(state, signers, opts) {
  const block = C.buildBlock(state, { proposer: signers[0].address, time: 1, ...opts });
  block.sigs = [];
  for (const w of signers) block.sigs.push(await C.signBlock(w, state, block));
  return { block, next: C.applyBlock(state, block) };
}

async function fund(ctx, who, amount) {
  const { next } = await commit(ctx.state, ctx.ais.slice(0, 3), { locks: [{ nonce: ctx.state.nextIn, to: who, amount }] });
  return next;
}

test("credit from a BSC lock, then a transfer pays exactly 1 Hat to the signers' owners", async () => {
  const ctx = setup();
  let s = await fund(ctx, ctx.alice.address, 2n * AGT);
  assert.equal(s.supply, 2n * AGT);
  const tx = await C.signTx(ctx.alice, { type: "transfer", chainId: s.chainId, to: ctx.bob.address, amount: AGT, fee: s.fee, nonce: 0 });
  const { next } = await commit(s, ctx.ais.slice(0, 3), { txs: [tx] });
  const b = (a) => next.balances[a.address.toLowerCase()] || 0n;
  assert.equal(b(ctx.bob), AGT);
  assert.equal(b(ctx.alice), AGT - C.HAT);
  const paid = ctx.owners.slice(0, 3).reduce((t, o) => t + b(o), 0n);
  assert.equal(paid, C.HAT, "the whole wage goes to the signers");
  assert.equal(b(ctx.owners[3]), 0n, "an owner whose AI did not sign gets nothing");
  const total = Object.values(next.balances).reduce((t, v) => t + v, 0n);
  assert.equal(total, next.supply, "fees move AGT, they never mint it");
});

test("the wage is fixed per transaction, not a percentage", async () => {
  const ctx = setup();
  let s = await fund(ctx, ctx.alice.address, 1000n * AGT);
  for (const amount of [1n, 999n * AGT]) {
    const tx = await C.signTx(ctx.alice, { type: "transfer", chainId: s.chainId, to: ctx.bob.address, amount, fee: s.fee, nonce: s.nonces[ctx.alice.address.toLowerCase()] || 0 });
    const before = s.balances[ctx.alice.address.toLowerCase()];
    s = (await commit(s, ctx.ais.slice(0, 3), { txs: [tx] })).next;
    assert.equal(before - s.balances[ctx.alice.address.toLowerCase()], amount + C.HAT);
  }
});

test("a block needs signatures from more than 2/3 of OWNERS — two AIs of one owner count once", async () => {
  const ctx = setup();
  // ai3 and ai3b belong to the same owner: with ai0 that is only 2 owners of 4.
  await assert.rejects(commit(ctx.state, [ctx.ais[0], ctx.ais[3], ctx.ais[4]], {}), /not enough signers/);
  await assert.rejects(commit(ctx.state, ctx.ais.slice(0, 2), {}), /not enough signers/);
  await commit(ctx.state, ctx.ais.slice(0, 3), {}); // 3 of 4 owners: passes
});

test("an outsider's signature is refused", async () => {
  const ctx = setup();
  await assert.rejects(commit(ctx.state, [ctx.ais[0], ctx.ais[1], W("intruder")], {}), /not a validator/);
});

test("a wrong fee, a replayed nonce or an overdraft is dropped by the proposer and refused by validators", async () => {
  const ctx = setup();
  const s = await fund(ctx, ctx.alice.address, AGT);
  const cheap = await C.signTx(ctx.alice, { type: "transfer", chainId: s.chainId, to: ctx.bob.address, amount: 1n, fee: 0n, nonce: 0 });
  const over = await C.signTx(ctx.alice, { type: "transfer", chainId: s.chainId, to: ctx.bob.address, amount: AGT, fee: s.fee, nonce: 0 });
  const block = C.buildBlock(s, { proposer: ctx.ais[0].address, time: 2, txs: [cheap, over] });
  assert.equal(block.txs.length, 0);
  // A dishonest proposer who includes them anyway cannot get the block accepted.
  const bad = { ...block, txs: [cheap] };
  bad.sigs = [];
  for (const w of ctx.ais.slice(0, 3)) bad.sigs.push(await C.signBlock(w, s, bad));
  assert.throws(() => C.applyBlock(s, bad), /fee must equal/);
});

test("credits must follow BSC lock order — none skipped, none repeated", async () => {
  const ctx = setup();
  const s = await fund(ctx, ctx.alice.address, AGT); // lock #1
  const again = C.buildBlock(s, { proposer: ctx.ais[0].address, time: 3, locks: [{ nonce: 1, to: ctx.alice.address, amount: AGT }] });
  assert.equal(again.credits.length, 0, "lock #1 is not credited twice");
  const skip = { ...again, credits: [{ nonce: 3, to: ctx.alice.address.toLowerCase(), amount: AGT }] };
  skip.sigs = [];
  for (const w of ctx.ais.slice(0, 3)) skip.sigs.push(await C.signBlock(w, s, skip));
  assert.throws(() => C.applyBlock(s, skip), /out of order/);
  const fake = { lockMatches: () => false, valset: () => ctx.valset };
  const two = C.buildBlock(s, { proposer: ctx.ais[0].address, time: 3, locks: [{ nonce: 2, to: ctx.bob.address, amount: AGT }] });
  two.sigs = [];
  for (const w of ctx.ais.slice(0, 3)) two.sigs.push(await C.signBlock(w, s, two));
  assert.throws(() => C.applyBlock(s, two, fake), /not found on BSC/);
});

test("fee changes need > 2/3 of owners and can never exceed the hard ceiling of 10 Hat", async () => {
  const ctx = setup();
  const sign = async (fee, ws) => ({
    type: "setFee", fee, feeNonce: 0,
    sigs: await Promise.all(ws.map(async (w) => ({ agent: w.address, sig: await w.signMessage(ethers.getBytes(C.feeDigest(ctx.state.chainId, fee, 0))) }))),
  });
  const s1 = C.applyTx(structuredClone(ctx.state), await sign(2n * C.HAT, ctx.ais.slice(0, 3)));
  assert.equal(s1, 0n);
  const all = await sign(11n * C.HAT, ctx.ais);
  assert.throws(() => C.applyTx(structuredClone(ctx.state), all), /hard ceiling/, "not even every AI together");
  const few = await sign(2n * C.HAT, ctx.ais.slice(0, 2));
  assert.throws(() => C.applyTx(structuredClone(ctx.state), few), /> 2\/3/);
});

test("withdraw burns on the AGT chain and the block carries release signatures for BSC", async () => {
  const ctx = setup();
  const s = await fund(ctx, ctx.alice.address, AGT);
  const tx = await C.signTx(ctx.alice, { type: "withdraw", chainId: s.chainId, to: ctx.alice.address, amount: AGT / 2n, fee: s.fee, nonce: 0 });
  const { block, next } = await commit(s, ctx.ais.slice(0, 3), { txs: [tx] });
  assert.equal(next.supply, AGT / 2n);
  assert.deepEqual(next.outbox[1], { to: ctx.alice.address.toLowerCase(), amount: AGT / 2n });
  const [w] = C.withdrawalsOf(s, block);
  const pkg = C.releasePackage(s, block, w, 0);
  assert.equal(pkg.sigs.length, 3);
  const d = C.releaseDigestRaw(97, ctx.bsc.bridge, 1, ctx.alice.address, AGT / 2n);
  for (const sig of pkg.sigs) assert.ok(ctx.ais.some((a) => ethers.verifyMessage(ethers.getBytes(d), sig) === a.address));
});

test("a validator-set change is signed by the OLD set and takes effect on the next block", async () => {
  const ctx = setup();
  const newAi = W("ai4"), newOwner = W("o4");
  const nextValset = { holders: 5, validators: [...ctx.valset.validators, { agent: newAi.address, holder: newOwner.address }] };
  const { next } = await commit(ctx.state, ctx.ais.slice(0, 3), { nextValset });
  assert.equal(next.valset.holders, 5);
  // Under 5 owners, 3 signatures are no longer > 2/3.
  await assert.rejects(commit(next, ctx.ais.slice(0, 3), {}), /not enough signers/);
  await commit(next, [...ctx.ais.slice(0, 3), newAi], {});
});
