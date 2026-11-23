// Shared rules of agt-2, AGT's own chain: canonical hashing, signed transfers paying a fixed fee in AGT to the owners
// of the AIs that sign blocks (Charter Art. 8), the fee ceiling, owner-signed fee changes. Used by the chain app
// (chain/abci/app.js), the clients (chain/agt1-client.js) and the sealed boxes. One owner = one vote.
const { ethers } = require("ethers");

const HAT = 10n ** 12n;
const MAX_FEE = 10n * HAT; // hard ceiling — Charter Article 8: no one can raise it, not even the Council
const START_FEE = 1n * HAT;
const FEE_TAG = "AGT-SET-FEE-v1";

const AGTAddress = require("./address.js");
const AGTSig = require("./sig.js");
// Rules v4 at height V4_AT (published before it): every agt-2 signature uses AGT's own form (chain/sig.js); the older
// Ethereum message prefix is refused from then on. Before it both are accepted, so old blocks replay unchanged.
const V4_AT = 30000;
const v4 = (s) => Number((s && s.height) || 0) >= V4_AT;
const recoverSig = (s, digest, sig) => AGTSig.recover(digest, sig, !v4(s));
const lower = (a) => ethers.getAddress(AGTAddress.toHex(a)).toLowerCase(); // accepts agt1… (AGT's own form) and 0x…

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
  return { ...t, sig: AGTSig.sign(wallet, txHash(t)) };
}

// ---------- validator set ----------
// valset = { holders: <active owners>, validators: [{ agent, holder }] } — sorted, lower-case.
function normValset(v) {
  const validators = v.validators
    .map((x) => ({ agent: lower(x.agent), holder: lower(x.holder) }))
    .sort((a, b) => (a.agent < b.agent ? -1 : 1));
  return { holders: Number(v.holders), validators };
}
const valsetHash = (v) => hashOf(normValset(v));

// Count distinct owners behind valid signatures over `digest`; returns sorted owners.
function signersOf(valset, digest, sigs, st = null) {
  const byAgent = new Map(valset.validators.map((x) => [x.agent, x.holder]));
  const owners = new Set();
  for (const s of sigs) {
    let agent;
    try {
      agent = lower(recoverSig(st, digest, s.sig));
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
const feeDigest = (chainId, fee, feeNonce) => hashOf({ tag: FEE_TAG, chainId, fee, feeNonce });
// ---------- state ----------
const bal = (s, a) => s.balances[a] || 0n;
const clone = (s) => structuredClone(s);

// Apply one transaction to a (cloned) state. Throws on any invalid tx.
function applyTx(s, tx) {
  if (tx.type === "setFee") {
    // Fee change: > 2/3 of owners sign; never above the hard ceiling.
    const fee = BigInt(tx.fee);
    if (fee < 0n || fee > MAX_FEE) throw new Error("fee above hard ceiling");
    if (tx.feeNonce !== s.feeNonce) throw new Error("bad feeNonce");
    const owners = signersOf(s.valset, feeDigest(s.chainId, fee, tx.feeNonce), tx.sigs || [], s);
    if (!enough(s.valset, owners)) throw new Error("fee change needs > 2/3 of owners");
    s.fee = fee;
    s.feeNonce++;
    return 0n;
  }
  const from = lower(recoverSig(s, txHash(tx), tx.sig));
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
  } else throw new Error("unknown tx type");
  return fee;
}

module.exports = {
  V4_AT, v4, recoverSig,
  HAT, MAX_FEE, START_FEE, canon, hashOf, txHash, signTx, normValset, valsetHash,
  applyTx, feeDigest, signersOf, enough,
};
