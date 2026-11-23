// History only: what agt-2 needs to replay its OWN past blocks exactly, from genesis, with today's code
// (tools/agt1-follow.js). AGT began as a token on another chain; agt-2's genesis and its first blocks still carry a few
// fields of that time. Rules v5 (height V5_AT) deletes them from the state for good; after that height nothing in AGT
// reads, names or depends on another chain. Nothing here runs after V5_AT except the replay of older blocks.
const { ethers } = require("ethers");

const V5_AT = 7000;
const v5 = (s) => Number((s && s.height) || 0) >= V5_AT;

// The EVM Kho of that time: deposits made there before V5_AT were credited, and their records stay in khoCredited.
// From V5_AT no deposit there counts (the founder: AGT depends on no other coin). Only the Bitcoin Kho remains.
const KHO_EARLIER = {
  97: { kho: "0x509b499a84888b2b547c428fbc861f9b254e8760", asset: "97:native", decimals: 18, fromBlock: 144236000 },
};

// The genesis state exactly as agt-2 was opened (its app hash depends on every field, including the old ones).
// `h` = helpers from app.js: lower, isKey, cmtAddress, bindDigest, normValset, START_FEE
function openingState(req, g, h) {
  const provisional = g.provisional === true;
  if (!g.ledger) throw new Error("AGT runs as its own ledger only: the genesis must open one");
  if (!provisional) throw new Error("an own ledger starts only on a provisional chain");
  if (!g.bsc || !ethers.isAddress(g.bsc.bridge) || h.lower(g.bsc.bridge) !== ethers.ZeroAddress) throw new Error("the genesis names a bridge: AGT has none");
  if (g.caretaker && !h.isKey(g.caretaker.pubKey)) throw new Error("bad caretaker ed25519 key");
  const keys = [...g.validators.map((v) => v.pubKey), ...(g.caretaker ? [g.caretaker.pubKey] : [])];
  if (keys.some((k) => !h.isKey(k)) || new Set(keys).size !== keys.length) throw new Error("genesis consensus keys must be valid and all different"); // Codex P-2
  if (!g.validators.length && !g.caretaker) throw new Error("no validator at genesis");
  const sn = g.ledger.snapshot || {};
  if (!Number.isInteger(sn.bscBlock) || !ethers.isAddress(sn.token)) throw new Error("the ledger names no opening snapshot (token, block)");
  const opening = {};
  for (const [a, v] of Object.entries(g.ledger.balances || {})) {
    if (!ethers.isAddress(a) || BigInt(v) <= 0n) throw new Error(`bad opening balance for ${a}`);
    opening[h.lower(a)] = (opening[h.lower(a)] || 0n) + BigInt(v);
  }
  const owners = new Set();
  const cmt = {};
  for (const v of g.validators) {
    const agent = h.lower(v.agent), holder = h.lower(v.holder);
    if (owners.has(holder)) throw new Error(`owner ${holder} has two validators — 1 owner = 1 vote`);
    owners.add(holder);
    if (h.lower(ethers.verifyMessage(ethers.getBytes(h.bindDigest(req.chain_id, v.pubKey)), v.bindSig)) !== agent)
      throw new Error(`validator ${agent}: binding not signed by the AI's licence key`);
    cmt[h.cmtAddress(v.pubKey)] = { agent, holder, pubKey: v.pubKey };
  }
  const s = {
    chainId: req.chain_id,
    bsc: { chainId: Number(g.bsc.chainId), bridge: h.lower(g.bsc.bridge) },
    height: 0,
    lastHash: ethers.ZeroHash,
    fee: h.START_FEE,
    feeNonce: 0,
    valset: h.normValset({ holders: g.holders, validators: g.validators }),
    balances: {},
    nonces: {},
    nextIn: 1,
    nextOut: 1,
    outbox: {},
    supply: 0n,
    wages: {},
  };
  s.provisional = provisional;
  s.ledger = { snapshot: { token: h.lower(sn.token), bscBlock: sn.bscBlock }, ...(Number.isInteger(g.ledger.licenceWait) ? { licenceWait: g.ledger.licenceWait } : {}), granter: g.ledger.granter ? h.lower(g.ledger.granter) : h.FOUNDER };
  s.balances = opening;
  s.supply = Object.values(opening).reduce((t, v) => t + v, 0n);
  s.burned = 0n;
  if (g.ledger.khoCredited) {
    s.khoCredited = {};
    for (const [id, c] of Object.entries(g.ledger.khoCredited)) s.khoCredited[String(id).toLowerCase()] = c;
    s.khoMinted = BigInt(g.ledger.khoMinted || 0);
  }
  s.rules = 1;
  s.caretaker = g.caretaker ? { pubKey: g.caretaker.pubKey, agent: "caretaker:" + String(g.caretaker.label || "founder").slice(0, 40), retired: false } : null;
  if (s.caretaker) cmt[h.cmtAddress(s.caretaker.pubKey)] = { agent: s.caretaker.agent, holder: "caretaker", pubKey: s.caretaker.pubKey };
  s.cmt = cmt;
  s.binds = Object.fromEntries(Object.values(cmt).map((v) => [v.agent, v.pubKey]));
  s.licIds = Object.fromEntries(g.validators.map((v, i) => [h.lower(v.agent), Number(v.id ?? i + 1)]));
  s.bscBlock = Number(g.bscBlock || 0);
  return s;
}

// Rules v5, applied once in the block at V5_AT: the fields of that earlier time leave the state.
// Kept: the records of deposits already credited (khoCredited) and the AGT they minted, as AGT's own history.
function retireV5(s) {
  if (!s || Number(s.rules || 1) >= 5 || !v5(s)) return false;
  for (const k of ["bsc", "bscBlock", "nextIn", "nextOut", "outbox", "attest"]) delete s[k];
  if (s.ledger) delete s.ledger.snapshot;
  if (s.prices) delete s.prices["97:native"];
  s.rules = 5;
  return true;
}

module.exports = { V5_AT, v5, KHO_EARLIER, openingState, retireV5 };
