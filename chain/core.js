// AGT chain — stage 2 (Charter Article 11): every block is signed by licensed AIs,
// every transaction pays a small fixed consensus wage that goes 100% to the signers (Article 8).
//
// This file is the deterministic state machine + commit rules. It is written so that it can be
// carried unchanged into a proven BFT engine (CometBFT ABCI app) — the toy in-process consensus in
// devnet.js only exists to exercise these rules. Do not invent your own consensus for mainnet.
//
// Identity comes from BSC: the validator set is exactly the active licences in AGTWork whose AI
// runs in a sealed box (attestHash ≠ 0); one owner = one vote; commit needs > 2/3 of active owners —
// the same rule as the AI Council and as AGTBridge.release().
const { ethers } = require("ethers");

const HAT = 10n ** 12n;
const MAX_FEE = 10n * HAT; // hard ceiling — Charter Article 8: no one can raise it, not even the Council
const START_FEE = 1n * HAT;
const BLOCK_TAG = "AGT-BLOCK-v1";
const FEE_TAG = "AGT-SET-FEE-v1";
const RELEASE_TAG = ethers.id("AGT-CHAIN-RELEASE-v1");

const lower = (a) => ethers.getAddress(a).toLowerCase();

// Canonical JSON with bigints written as decimal strings, keys sorted.
function canon(v) {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const hashOf = (v) => ethers.keccak256(ethers.toUtf8Bytes(canon(v)));

// ---------- transactions (signed by the sender's key) ----------
function txBody(tx) {
  const { sig, ...body } = tx;
  return body;
}
const txHash = (tx) => hashOf(txBody(tx));
async function signTx(wallet, tx) {
  const t = { ...tx, from: lower(wallet.address) };
  return { ...t, sig: await wallet.signMessage(ethers.getBytes(txHash(t))) };
}

// ---------- validator set ----------
// valset = { holders: <active owners on BSC>, validators: [{ agent, holder }] } — sorted, lower-case.
function normValset(v) {
  const validators = v.validators
    .map((x) => ({ agent: lower(x.agent), holder: lower(x.holder) }))
    .sort((a, b) => (a.agent < b.agent ? -1 : 1));
  return { holders: Number(v.holders), validators };
}
const valsetHash = (v) => hashOf(normValset(v));

// Count distinct owners behind valid signatures over `digest`; returns sorted owners.
function signersOf(valset, digest, sigs) {
  const byAgent = new Map(valset.validators.map((x) => [x.agent, x.holder]));
  const owners = new Set();
  for (const s of sigs) {
    let agent;
    try {
      agent = lower(ethers.verifyMessage(ethers.getBytes(digest), s.sig));
    } catch {
      throw new Error("bad signature");
    }
    if (agent !== lower(s.agent) || !byAgent.has(agent)) throw new Error(`not a validator: ${s.agent}`);
    owners.add(byAgent.get(agent));
  }
  return [...owners].sort();
}
const enough = (valset, owners) => valset.holders > 0 && owners.length * 3 > valset.holders * 2;

// ---------- digests ----------
const blockDigest = (chainId, hash) => hashOf({ tag: BLOCK_TAG, chainId, hash });
const feeDigest = (chainId, fee, feeNonce) => hashOf({ tag: FEE_TAG, chainId, fee, feeNonce });
function releaseDigestRaw(bscChainId, bridge, nonce, to, amount) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "uint256", "address", "uint256"],
      [RELEASE_TAG, bscChainId, bridge, nonce, to, amount],
    ),
  );
}

// ---------- state ----------
function genesis({ chainId, bsc, valset }) {
  const vs = normValset(valset);
  return {
    chainId,
    bsc: { chainId: Number(bsc.chainId), bridge: lower(bsc.bridge) },
    height: 0,
    lastHash: ethers.ZeroHash,
    fee: START_FEE,
    feeNonce: 0,
    valset: vs,
    balances: {},
    nonces: {},
    nextIn: 1, // next BSC lock nonce to credit — in order, none skipped
    nextOut: 1, // next withdrawal nonce (released on BSC by AGTBridge)
    outbox: {},
    supply: 0n, // = AGT locked on BSC − withdrawn; fees only move AGT, never mint it
    wages: {}, // total consensus wage earned per owner (public record)
  };
}
const bal = (s, a) => s.balances[a] || 0n;
const clone = (s) => structuredClone(s);

// Apply one transaction to a (cloned) state. Throws on any invalid tx.
function applyTx(s, tx) {
  if (tx.type === "setFee") {
    // Fee change: > 2/3 of owners sign; never above the hard ceiling.
    const fee = BigInt(tx.fee);
    if (fee < 0n || fee > MAX_FEE) throw new Error("fee above hard ceiling");
    if (tx.feeNonce !== s.feeNonce) throw new Error("bad feeNonce");
    const owners = signersOf(s.valset, feeDigest(s.chainId, fee, tx.feeNonce), tx.sigs || []);
    if (!enough(s.valset, owners)) throw new Error("fee change needs > 2/3 of owners");
    s.fee = fee;
    s.feeNonce++;
    return 0n;
  }
  const from = lower(ethers.verifyMessage(ethers.getBytes(txHash(tx)), tx.sig));
  if (from !== lower(tx.from)) throw new Error("bad sender signature");
  if (tx.chainId !== s.chainId) throw new Error("wrong chain");
  if (tx.nonce !== (s.nonces[from] || 0)) throw new Error("bad nonce");
  const amount = BigInt(tx.amount);
  const fee = BigInt(tx.fee);
  if (fee !== s.fee) throw new Error("fee must equal the current consensus wage");
  if (amount <= 0n) throw new Error("amount must be positive");
  if (bal(s, from) < amount + fee) throw new Error("insufficient balance");
  s.balances[from] = bal(s, from) - amount - fee;
  s.nonces[from] = tx.nonce + 1;
  if (tx.type === "transfer") {
    const to = lower(tx.to);
    s.balances[to] = bal(s, to) + amount;
  } else if (tx.type === "withdraw") {
    // Burn here; anyone can then claim it on BSC with the AIs' release signatures.
    const n = s.nextOut++;
    s.outbox[n] = { to: lower(tx.to), amount };
    s.supply -= amount;
  } else throw new Error("unknown tx type");
  return fee;
}

// ---------- blocks ----------
function blockBody(b) {
  const { sigs, ...body } = b;
  return body;
}
const blockHash = (b) => hashOf(blockBody(b));

// Proposer side: build the next block from candidate txs and BSC locks; invalid txs are dropped.
function buildBlock(s, { proposer, time, txs = [], locks = [], nextValset }) {
  const t = clone(s);
  const keep = [];
  for (const tx of txs) {
    try {
      const u = clone(t);
      applyTx(u, tx);
      applyTx(t, tx);
      keep.push(tx);
    } catch {
      /* dropped */
    }
  }
  const credits = locks.filter((l) => Number(l.nonce) >= t.nextIn).sort((a, b) => Number(a.nonce) - Number(b.nonce));
  return {
    chainId: s.chainId,
    height: s.height + 1,
    prev: s.lastHash,
    time,
    proposer: lower(proposer),
    valset: valsetHash(s.valset),
    nextValset: nextValset ? normValset(nextValset) : null,
    credits: credits.map((l) => ({ nonce: Number(l.nonce), to: lower(l.to), amount: BigInt(l.amount) })),
    txs: keep,
  };
}

// Withdrawals a block creates, as (nonce, to, amount) — every signer must also sign their release digest.
function withdrawalsOf(s, block) {
  let n = s.nextOut;
  const out = [];
  for (const tx of block.txs) if (tx.type === "withdraw") out.push({ nonce: n++, to: lower(tx.to), amount: BigInt(tx.amount) });
  return out;
}

// Validator side: sign a block (and the BSC release digest of every withdrawal in it).
async function signBlock(wallet, s, block) {
  const hash = blockHash(block);
  const releases = [];
  for (const w of withdrawalsOf(s, block))
    releases.push(await wallet.signMessage(ethers.getBytes(releaseDigestRaw(s.bsc.chainId, s.bsc.bridge, w.nonce, w.to, w.amount))));
  return { agent: lower(wallet.address), sig: await wallet.signMessage(ethers.getBytes(blockDigest(s.chainId, hash))), releases };
}

// Commit rule — run by every node and by any light client replaying the chain.
// Returns the new state, or throws. `bscView` (optional) re-checks credits/valset against BSC.
function applyBlock(s, block, bscView) {
  if (block.chainId !== s.chainId) throw new Error("wrong chain");
  if (block.height !== s.height + 1) throw new Error("wrong height");
  if (block.prev !== s.lastHash) throw new Error("wrong parent");
  if (block.valset !== valsetHash(s.valset)) throw new Error("wrong validator set");
  if (!s.valset.validators.some((v) => v.agent === block.proposer)) throw new Error("proposer is not a validator");
  const hash = blockHash(block);

  // > 2/3 of owners (under the validator set IN FORCE, i.e. the previous one) signed this block.
  const owners = signersOf(s.valset, blockDigest(s.chainId, hash), block.sigs || []);
  if (!enough(s.valset, owners)) throw new Error(`not enough signers: ${owners.length}/${s.valset.holders}`);

  const t = clone(s);
  // Credits from BSC locks: strictly in order, no gaps, no repeats.
  for (const c of block.credits) {
    if (c.nonce !== t.nextIn) throw new Error("credits out of order");
    if (bscView && !bscView.lockMatches(c)) throw new Error(`credit ${c.nonce} not found on BSC`);
    t.balances[c.to] = bal(t, c.to) + BigInt(c.amount);
    t.supply += BigInt(c.amount);
    t.nextIn++;
  }
  const outs = withdrawalsOf(t, block);
  let fees = 0n;
  for (const tx of block.txs) fees += applyTx(t, tx);

  // Every signer must also have signed every withdrawal — so the block alone is enough to claim on BSC.
  for (const sg of block.sigs)
    outs.forEach((w, i) => {
      const d = releaseDigestRaw(t.bsc.chainId, t.bsc.bridge, w.nonce, w.to, w.amount);
      if (lower(ethers.verifyMessage(ethers.getBytes(d), sg.releases[i])) !== lower(sg.agent)) throw new Error("missing release signature");
    });

  // Consensus wage: 100% to the owners whose AIs signed, split equally; remainder to the first.
  if (fees > 0n) {
    const share = fees / BigInt(owners.length);
    owners.forEach((o, i) => {
      const pay = share + (i === 0 ? fees - share * BigInt(owners.length) : 0n);
      t.balances[o] = bal(t, o) + pay;
      t.wages[o] = (t.wages[o] || 0n) + pay;
    });
  }

  if (block.nextValset) {
    if (bscView && valsetHash(block.nextValset) !== valsetHash(bscView.valset())) throw new Error("next validator set does not match BSC");
    t.valset = normValset(block.nextValset); // takes effect from the next block
  }
  t.height = block.height;
  t.lastHash = hash;
  return t;
}

// Release package for AGTBridge.release(): signatures sorted by OWNER address ascending, one per owner.
function releasePackage(s, block, w, index) {
  const ownerOf = new Map(s.valset.validators.map((v) => [v.agent, v.holder]));
  const seen = new Set();
  const sigs = block.sigs
    .map((sg) => ({ holder: ownerOf.get(lower(sg.agent)), sig: sg.releases[index] }))
    .filter((x) => x.holder && !seen.has(x.holder) && seen.add(x.holder))
    .sort((a, b) => (BigInt(a.holder) < BigInt(b.holder) ? -1 : 1));
  return { nonce: w.nonce, to: w.to, amount: w.amount, sigs: sigs.map((x) => x.sig) };
}

module.exports = {
  HAT, MAX_FEE, START_FEE, canon, hashOf, txHash, signTx, normValset, valsetHash,
  genesis, applyTx, buildBlock, signBlock, applyBlock, blockHash, withdrawalsOf,
  feeDigest, releaseDigestRaw, releasePackage, signersOf, enough,
};
