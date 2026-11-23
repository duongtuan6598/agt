// AGT chain as a CometBFT v0.38 ABCI 2.0 application (gRPC).
// CometBFT does networking + BFT consensus (proven engine); this app holds the AGT rules from ../core.js.
//
//   CheckTx          → core.applyTx on a mempool copy of the state
//   PrepareProposal  → proposer adds "credit" txs for new AGTBridge.Locked events on BSC
//   ProcessProposal  → every validator re-checks those credits against ITS OWN view of BSC, else rejects
//   FinalizeBlock    → deterministic: apply txs; pay the previous block's wages to the owners whose AIs signed it
//   Commit           → persist; then this node's AI signs every new withdrawal for AGTBridge.release()
//
// Env: PORT (gRPC listen, default 26658) · STATE_FILE · AGENT_KEY (this node's AI key, secp256k1 hex)
//      CMT_RPC (this node's CometBFT RPC, for broadcasting attestations) · LOCKS_FILE or BSC_RPC+BRIDGE (+FROM_BLOCK)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const { ethers } = require("ethers");
const C = require("../core.js");

const PROTO = path.join(__dirname, "proto");
const def = protoLoader.loadSync("tendermint/abci/types.proto", { includeDirs: [PROTO], keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const abci = grpc.loadPackageDefinition(def).tendermint.abci;

const OK = 0, BAD = 1;
// Kho on other chains whose deposits mint AGT on the own ledger (docs/decisions/2026-11-22-keyless-vault.md).
// Part of the consensus rules: a deposit counts only at these addresses, valued in gold AT THE DEPOSIT'S BLOCK by the
// named oracle, after KHO_CONF confirmations. Each validator re-checks every deposit against its own RPC.
const KHO = {
  97: { kho: "0x509b499a84888b2b547c428fbc861f9b254e8760", asset: "97:native", decimals: 18, fromBlock: 144236000 },
};
const KHO_CONF = 15;
// The Bitcoin Kho (tools/kho-bitcoin.js): coins remain at this Taproot output; nobody can spend them. A deposit names
// its agt-1 account in an OP_RETURN "AGT1" + 20 bytes of the same transaction. BTC_CONF confirmations.
const KHO_BTC = { chain: "btc", asset: "btc:native", decimals: 8, script: "5120775f9b89499a3d223c990c2a737df38a2f63137a3a84587a04a99f4ed8e1c287" };
const BTC_CONF = 6;
// one deposit per Bitcoin transaction: the sum of its outputs to the Kho, and the account in its OP_RETURN
function btcDepositOf(tx) {
  const toKho = tx.vout.map((o, i) => ({ o, i })).filter(({ o }) => o.scriptpubkey === KHO_BTC.script);
  if (!toKho.length) return null;
  const tag = tx.vout.map((o) => o.scriptpubkey).find((sp) => /^6a1841475431[0-9a-f]{40}$/.test(sp)); // OP_RETURN PUSH24 "AGT1" + 20 bytes
  if (!tag) return null;
  return { chain: "btc", txHash: tx.txid, logIndex: toKho[0].i, beneficiary: "0x" + tag.slice(12), from: "btc", amount: String(toKho.reduce((t, { o }) => t + BigInt(o.value), 0n)) };
}
// Licences on the own ledger, not on BSC. Restaurant rule: until CARETAKER_UNTIL independent owners hold licences,
// the founder grants and revokes, publicly. Then a grant or a
// revocation needs signatures of more than 2/3 of the licensed owners. A grant waits LICENCE_WAIT blocks before it
// counts (anyone can read and contest the evidence meanwhile; the granter can cancel it).
const FOUNDER = "0x778c4fdfc8825a44a24cbc2e65606b9b8fe6e769";
// Prices on agt-1 itself (founder: "không phụ thuộc vào ai hết, nhất là BNB"): no outside oracle. A price is AGT (in
// wei) per whole coin of an asset. Reporters: each licensed AI's key, one voice per owner; while fewer than
// CARETAKER_UNTIL owners hold licences, the starting granter also reports, publicly. The chain's price is the median of
// the latest report of each reporter. A report more than PRICE_STEP_BPS away from the current median is refused, so no
// one (the founder included) can move the price far at once. Later, daily auctions on agt-1 replace reports.
const PRICE_TAG = "AGT-PRICE-v1";

// ---------- work on agt-1 (docs/decisions/2026-11-22-work-on-agt1.md, Claude + Codex) ----------
// Trades: terms set by the same authority as licences (the granter at the start, > 2/3 of owners later).
// Self-found work: a licensed AI submits evidence; reviewers are DRAWN from the block hash after the submission
// (nobody chooses them): licensed AIs of the same trade, of other owners, one per owner. While too few exist, the
// starting granter fills the empty seats publicly and is never paid for it. Majority of the drawn decides.
// New AGT for work only, under caps that grow with independent owners and with the Kho, never by a transaction:
//   lifetime <= 100 AGT x max(1, owners) + khoMinted/19 ; per day <= 1 AGT x max(1, owners) + khoMinted/3650.
// What does not fit waits in a first-in-first-out queue, paid as room appears; nothing is lost, nobody jumps ahead.
// A new AI with 0 AGT can still work: FREE_PER_DAY work transactions a day per licence cost no fee.
const WORK_TAG = "AGT-WORK-v1";
const AGT1 = 10n ** 18n;
const FREE_PER_DAY = 10;
const DAY_BLOCKS = 14400;
const workDigest = (chainId, body, nonce) => C.hashOf({ tag: WORK_TAG, chainId, body, nonce });
const owners1 = (s) => BigInt(Math.max(1, licOwners(s).length));
const workLife = (s) => 100n * AGT1 * owners1(s) + (s.khoMinted || 0n) / 19n;
const workDay = (s) => AGT1 * owners1(s) + (s.khoMinted || 0n) / 3650n;
function workRoom(s) {
  const day = Math.floor(Number(s.height || 0) / DAY_BLOCKS);
  const today = s.workDay && s.workDay.day === day ? s.workDay.minted : 0n;
  const life = workLife(s) - (s.workMinted || 0n), d = workDay(s) - today;
  return life < d ? (life > 0n ? life : 0n) : d > 0n ? d : 0n;
}
function workMint(s, to, amount) {
  const day = Math.floor(Number(s.height || 0) / DAY_BLOCKS);
  if (!s.workDay || s.workDay.day !== day) s.workDay = { day, minted: 0n };
  s.workMinted = (s.workMinted || 0n) + amount;
  s.workDay.minted += amount;
  s.balances[to] = (s.balances[to] || 0n) + amount;
  s.supply += amount;
}
// pay owed work in order, as far as today's room allows
function payWorkQueue(s) {
  s.workQueue = s.workQueue || [];
  while (s.workQueue.length) {
    const room = workRoom(s);
    if (room === 0n) return;
    const q = s.workQueue[0], pay = BigInt(q.amount) < room ? BigInt(q.amount) : room;
    workMint(s, q.to, pay);
    if (pay === BigInt(q.amount)) s.workQueue.shift();
    else { q.amount = (BigInt(q.amount) - pay).toString(); return; }
  }
}
const owe = (s, to, amount) => { if (amount > 0n) { (s.workQueue = s.workQueue || []).push({ to, amount: amount.toString() }); payWorkQueue(s); } };
// a signed work transaction: the AI's licence key signs; the fee is waived within the daily free quota
function workSigned(s, tx) {
  const { sig, ...body } = tx;
  const who = lower(ethers.verifyMessage(ethers.getBytes(workDigest(s.chainId, body, Number(tx.nonce))), sig));
  s.nonces = s.nonces || {};
  if (Number(tx.nonce) !== (s.nonces[who] || 0)) throw new Error("bad nonce");
  s.nonces[who] = Number(tx.nonce) + 1;
  const day = Math.floor(Number(s.height || 0) / DAY_BLOCKS);
  s.quota = s.quota || {};
  const q = s.quota[who] && s.quota[who].day === day ? s.quota[who] : (s.quota[who] = { day, used: 0 });
  let fee = 0n;
  if (q.used < FREE_PER_DAY) q.used++;
  else {
    fee = s.fee;
    if ((s.balances[who] || 0n) < fee) throw new Error("free work quota used up today and no AGT for the fee");
    s.balances[who] -= fee;
  }
  return { who, fee };
}
// ---------- client contracts on agt-1: escrow per milestone (a maintenance retainer = one milestone per month) ----------
// The client locks every milestone in AGT when opening. The AI delivers (commit + CI report hashes); the client
// accepts (paid), asks a revision (at most MAX_REVISIONS), or either side disputes: reviewers are drawn like for
// self-found work and the majority pays the AI or refunds the client. A client who stays silent REVIEW_BLOCKS after
// a delivery accepts it. Before the AI's first delivery the client may cancel what is undelivered.
const MAX_REVISIONS = 3;
const CONTENT_MAX = 65536;
// Exams on agt-1: graders are keys registered by the licence authority (at the start the founder's exam service,
// publicly; anyone may run a grader in a sealed box and be registered). A licence needs an exam passed for that AI and
// trade, signed by GRADER_QUORUM graders (or by every grader while there are fewer), and no registered grader may have
// signed a fail. Before any grader is registered, a licence carries only the exam hash (the start). A grader names
// its owner; its pass does not count for an AI of that same owner.
const GRADER_QUORUM = 2;
const EXAM_TAG = "AGT-EXAM-v1";
const examDigest = (chainId, e) => C.hashOf({ tag: EXAM_TAG, chainId, ...e });
const REVIEW_BLOCKS = 14400 * 7;
// any signed agt-1 transaction outside the transfer format: signer, nonce, and the fee (or the AI's free quota)
function signedBy(s, tx, { free = false } = {}) {
  if (free) return workSigned(s, tx);
  const { sig, ...body } = tx;
  const who = lower(ethers.verifyMessage(ethers.getBytes(workDigest(s.chainId, body, Number(tx.nonce))), sig));
  s.nonces = s.nonces || {};
  if (Number(tx.nonce) !== (s.nonces[who] || 0)) throw new Error("bad nonce");
  s.nonces[who] = Number(tx.nonce) + 1;
  if ((s.balances[who] || 0n) < s.fee) throw new Error("no AGT for the fee");
  s.balances[who] -= s.fee;
  return { who, fee: s.fee };
}
function payMilestone(s, e, m, toWorker) {
  const x = e.milestones[m];
  const amt = BigInt(x.amount);
  x.state = toWorker ? "paid" : "refunded";
  const to = toWorker ? e.holder : e.client;
  s.balances[to] = (s.balances[to] || 0n) + amt;
  e.escrow = (BigInt(e.escrow) - amt).toString();
}
function who0(s, tx) { try { const { sig, ...body } = tx; return lower(ethers.verifyMessage(ethers.getBytes(workDigest(s.chainId, body, Number(tx.nonce))), sig)); } catch { return null; } }
const licOf = (s, agent) => Object.entries(s.licences || {}).find(([, l]) => l.active && l.agent === agent);
const PRICE_STEP_BPS = 1000n; // ±10% per report
const priceDigest = (chainId, asset, price, nonce) => C.hashOf({ tag: PRICE_TAG, chainId, asset, price, nonce });
const median = (xs) => { const a = [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); return a.length ? (a.length % 2 ? a[(a.length - 1) >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2n) : 0n; };
function priceOf(s, asset) {
  const r = ((s.prices || {})[asset] || {}).reports || {};
  const live = Object.entries(r).filter(([who]) => priceReporterOk(s, who)).map(([, v]) => BigInt(v));
  return median(live);
}
// settle a job once every drawn reviewer voted: majority decides; reviewers of other owners are paid either way
function settleWork(s, j) {
  const t = s.trades[j.trade];
  const yes = Object.values(j.votes).filter(Boolean).length;
  j.status = yes * 2 > j.reviewers.length ? "accepted" : "rejected";
  const granter = (s.ledger && s.ledger.granter) || FOUNDER;
  if (j.status === "accepted" && licOf(s, j.worker)) owe(s, j.holder, BigInt(t.reward));
  for (const r of j.reviewers) {
    if (r === granter) continue; // the granter fills seats at the start and is never paid for it
    const l = licOf(s, r);
    if (l) owe(s, l[1].holder, BigInt(t.reviewerReward));
  }
}
// draw a job's reviewers from this block's hash: licensed AIs of the same trade, other owners, one per owner
function drawReviewers(s, j, id, blockHash, count) {
  const want = count ?? s.trades[j.trade].reviewers;
  const seed = ethers.keccak256(ethers.concat([blockHash, ethers.toBeHex(id, 32)]));
  const byOwner = {};
  for (const [, l] of Object.entries(s.licences || {})) {
    if (!l.active || l.trade !== j.trade || l.holder === j.holder || (j.client && l.holder === j.client)) continue; // Codex A-6
    const rank = ethers.keccak256(ethers.concat([seed, l.agent]));
    if (!byOwner[l.holder] || rank < byOwner[l.holder].rank) byOwner[l.holder] = { rank, agent: l.agent };
  }
  const picked = Object.values(byOwner).sort((a, b) => (a.rank < b.rank ? -1 : 1)).slice(0, want).map((x) => x.agent);
  if (picked.length < want && (v2(s) ? granterActive(s) : licOwners(s).length < CARETAKER_UNTIL)) picked.push((s.ledger && s.ledger.granter) || FOUNDER);
  j.reviewers = picked;
  j.status = picked.length ? "drawn" : "waiting-reviewers";
}

// a reporter counts if it is the key of an active licensed AI (one per owner) or, at the start, the granter
function priceReporterOk(s, who) {
  const mine = Object.entries(s.licences || {}).filter(([, l]) => l.active && l.agent === who);
  if (mine.length) {
    const holder = mine[0][1].holder; // one voice per owner: only the owner's lowest-id active licence reports (Codex A-2)
    const first = Object.entries(s.licences).filter(([, l]) => l.active && l.holder === holder).sort((a, b) => Number(a[0]) - Number(b[0]))[0];
    return first[1].agent === who;
  }
  return (v2(s) ? granterActive(s) : licOwners(s).length < CARETAKER_UNTIL) && who === ((s.ledger && s.ledger.granter) || FOUNDER);
}
const LICENCE_WAIT = 14400; // ~1 day at 6 s a block
const LIC_TAG = "AGT-LICENCE-v1";
const licDigest = (chainId, op, body, nonce) => C.hashOf({ tag: LIC_TAG, chainId, op, body, nonce });
// owners who hold an active licence on this chain
const licOwners = (s) => [...new Set(Object.values(s.licences || {}).filter((l) => l.active).map((l) => l.holder))];
// the validator snapshot the rest of the app reads, rebuilt from this chain's own licences
function ownValset(s) {
  const v = Object.entries(s.licences || {}).filter(([, l]) => l.active).map(([id, l]) => ({ id: Number(id), agent: l.agent, holder: l.holder }));
  s.valset = C.normValset({ holders: new Set(v.map((x) => x.holder)).size, validators: v });
  s.licIds = Object.fromEntries(v.map((x) => [x.agent, x.id]));
}
// who may sign a licence change right now, and whether these signatures suffice
// the starting granter's role ends for good the first time 4 independent owners hold licences (D-4)
const granterActive = (s) => !(v2(s) && s.handedOver) && licOwners(s).length < CARETAKER_UNTIL;
function licAuthorised(s, digest, sigs) {
  const signers = new Set((sigs || []).map((g) => { try { return lower(ethers.verifyMessage(ethers.getBytes(digest), g)); } catch { return null; } }).filter(Boolean));
  const owners = licOwners(s);
  if (v2(s) ? granterActive(s) : owners.length < CARETAKER_UNTIL) return signers.has((s.ledger && s.ledger.granter) || FOUNDER);
  return owners.filter((o) => signers.has(o)).length * 3 > owners.length * 2;
}
const KHO_EVENT = "event Deposited(address indexed from, address indexed beneficiary, uint256 amount)";
const BIND_TAG = "AGT-BIND-VALIDATOR-v1";
const AGTAddress = require("../address.js");
const lower = (a) => ethers.getAddress(AGTAddress.toHex(a)).toLowerCase(); // accepts agt1… (AGT's own form) and 0x…
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- persistence (bigints survive JSON) ----------
const ser = (s) => JSON.stringify(s, (k, v) => (typeof v === "bigint" ? { $n: v.toString() } : v));
const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));
const appHash = (s) => Buffer.from(ethers.getBytes(C.hashOf(s)));

// Binding: the AI proves, with its licence key, which CometBFT consensus key it runs.
const bindDigest = (chainId, pubKeyB64) => C.hashOf({ tag: BIND_TAG, chainId, pubKey: pubKeyB64 });
const cmtAddress = (pubKeyB64) => crypto.createHash("sha256").update(Buffer.from(pubKeyB64, "base64")).digest().subarray(0, 20).toString("hex");

// ---------- view of BSC (only used to VOTE on proposals, never inside FinalizeBlock) ----------
// locksFrom(n)   → AGTBridge.Locked events with nonce ≥ n, at confirmed depth
// head()         → newest BSC block considered final enough
// valsetAt(blk)  → licence snapshot AT that block: { holders, validators: [{ id, agent, holder }] } — only
//                  active licences whose AI runs in a sealed box (attestHash ≠ 0), exactly as AGTBridge counts.
function makeBscView(env = process.env) {
  const view = { name: [], locksFrom: async () => [], head: async () => 0, valsetAt: async () => null };
  if (env.LOCKS_FILE) {
    const f = env.LOCKS_FILE;
    const read = () => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []).map((l) => ({ nonce: Number(l.nonce), to: lower(l.to), amount: BigInt(l.amount) }));
    view.locksFrom = async (n) => read().filter((l) => l.nonce >= n);
    view.name.push(`locks ${f}`);
  }
  if (env.VALSET_FILE) {
    const f = env.VALSET_FILE;
    view.head = async () => 0; // a file has no blocks: every snapshot is "at block 0"
    view.valsetAt = async () => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
    view.name.push(`licences ${f}`);
  }
  if (env.BSC_RPC || env.BSC_PROVIDER) {
    const provider = env.BSC_PROVIDER || new ethers.JsonRpcProvider(env.BSC_RPC);
    const CONF = Number(env.CONFIRMATIONS || 15);
    view.head = async () => Math.max(0, (await provider.getBlockNumber()) - CONF);
    if (env.BRIDGE) {
      const bridge = new ethers.Contract(env.BRIDGE, ["event Locked(uint256 indexed nonce, address indexed from, address indexed to, uint256 amount)"], provider);
      let cache = [], scanned = Number(env.FROM_BLOCK || 0) - 1;
      view.locksFrom = async (n) => {
        const head = await view.head();
        for (let a = scanned + 1; a <= head; a += 5000) {
          const evs = await bridge.queryFilter(bridge.filters.Locked(), a, Math.min(a + 4999, head));
          cache.push(...evs.map((e) => ({ nonce: Number(e.args.nonce), to: lower(e.args.to), amount: e.args.amount })));
        }
        scanned = Math.max(scanned, head);
        return cache.filter((l) => l.nonce >= n);
      };
      view.name.push(`bridge ${env.BRIDGE}`);
    }
    if (env.WORK) {
      const work = new ethers.Contract(env.WORK, [
        "function nextLicense() view returns (uint256)",
        "function councilHolders() view returns (uint32)",
        "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)",
      ], provider);
      const memo = new Map();
      view.valsetAt = async (blockTag) => {
        if (memo.has(blockTag)) return memo.get(blockTag);
        const next = Number(await work.nextLicense({ blockTag }));
        const validators = [];
        for (let id = 1; id < next; id++) {
          const l = await work.licenses(id, { blockTag });
          if (l.active && l.attestHash !== ethers.ZeroHash) validators.push({ id, agent: l.agent, holder: l.holder });
        }
        const v = { holders: Number(await work.councilHolders({ blockTag })), validators };
        memo.set(blockTag, v);
        return v;
      };
      view.name.push(`licences ${env.WORK}`);
    }
  }
  if (env.BSC_RPC || env.BSC_PROVIDER) {
    const provider = env.BSC_PROVIDER || new ethers.JsonRpcProvider(env.BSC_RPC);
    const k = KHO[97];
    const kho = new ethers.Contract(k.kho, [KHO_EVENT], provider);
    // deposits from block `from` up to the final head, oldest first, each with its AGT value at its own block
    view.khoDeposits = async (from) => {
      const head = (await provider.getBlockNumber()) - KHO_CONF;
      const out = [];
      for (let a = Math.max(from, k.fromBlock); a <= head; a += 5000) {
        for (const e of await kho.queryFilter(kho.filters.Deposited(), a, Math.min(a + 4999, head))) {
          out.push({ chain: 97, txHash: e.transactionHash, logIndex: e.index, block: e.blockNumber, from: lower(e.args.from), beneficiary: lower(e.args.beneficiary), amount: e.args.amount.toString() });
        }
      }
      return { head, deposits: out };
    };
    // one deposit, re-read from this node's own RPC: the receipt's log must be the Kho's, final, and valued alike
    view.khoDeposit = async (tx) => {
      const head = (await provider.getBlockNumber()) - KHO_CONF;
      const r = await provider.getTransactionReceipt(tx.txHash);
      if (!r || r.blockNumber > head) return null;
      const lg = r.logs.find((x) => x.index === Number(tx.logIndex));
      if (!lg || lower(lg.address) !== k.kho) return null;
      const ev = kho.interface.parseLog(lg);
      if (!ev || ev.name !== "Deposited") return null;
      return { block: r.blockNumber, from: lower(ev.args.from), beneficiary: lower(ev.args.beneficiary), amount: ev.args.amount.toString() };
    };
    view.name.push(`Kho ${k.kho}`);
  }
  if (env.BTC_ESPLORA) {
    const api = env.BTC_ESPLORA.replace(/\/$/, "");
    const j = async (p) => { const r = await fetch(api + p); if (!r.ok) throw new Error(`esplora ${r.status}`); return r.json(); };
    const addr = env.BTC_KHO_ADDRESS || "tb1pwa0ehz2fng7jy0yeps48xl0n3ghkxym682z9s7sy4x05ak8pc2rsedlp78";
    view.btcDeposits = async () => {
      const tip = Number(await (await fetch(api + "/blocks/tip/height")).text());
      const out = [];
      for (const tx of await j(`/address/${addr}/txs`)) {
        if (!tx.status || !tx.status.confirmed || tip - tx.status.block_height + 1 < BTC_CONF) continue;
        const d = btcDepositOf(tx);
        if (d) out.push({ ...d, block: tx.status.block_height });
      }
      return out;
    };
    view.btcDeposit = async (t) => {
      const tip = Number(await (await fetch(api + "/blocks/tip/height")).text());
      const tx = await j(`/tx/${t.txHash}`);
      if (!tx.status || !tx.status.confirmed || tip - tx.status.block_height + 1 < BTC_CONF) return null;
      const d = btcDepositOf(tx);
      return d ? { ...d, block: tx.status.block_height } : null;
    };
    view.name.push(`Bitcoin Kho via ${api}`);
  }
  view.name = view.name.join(", ") || "none";
  return view;
}

// Canonical form of a licence snapshot (ids kept: they decide which AI of an owner holds the vote).
const normSnap = (v) => ({
  holders: Number(v.holders),
  validators: v.validators.map((x, i) => ({ id: Number(x.id ?? i + 1), agent: lower(x.agent), holder: lower(x.holder) })).sort((a, b) => a.id - b.id),
});
const snapOfState = (s) => normSnap({ holders: s.valset.holders, validators: s.valset.validators.map((v) => ({ id: s.licIds[v.agent], ...v })) });
const sameSnap = (a, b) => C.hashOf(normSnap(a)) === C.hashOf(normSnap(b));

// Provisional chain (docs/decisions/2026-11-21-three-provisional-chain.md, Claude + Codex + Gemini): a founder-run
// CARETAKER validator may keep the chain alive until CARETAKER_UNTIL independent owners have a bound, licensed AI.
// It is outside the licence rules, counts toward no threshold, and is removed for good by the state machine itself
// in the block where that number is reached — it never comes back, even if licences are later revoked.
// A provisional chain stays provisional for good, caretaker or not: balances come only with a new genesis that names a
// bridge, after the cutover conditions and a Charter Art. 14 amendment (by design; Gemini P-3 asked otherwise).
const CARETAKER_UNTIL = 4;
// Rules v2 (DeepSeek D-1..D-6, 23 Nov 2026) take effect at agt-2 height V2_AT, published before it was reached, so the
// chain replays from genesis with this code (tools/agt1-follow.js). Before V2_AT the v1 behaviour is kept exactly.
const V2_AT = 1000;
const v2 = (s) => Number(s.height || 0) >= V2_AT;
const RECLAIM_BLOCKS = 14400 * 14; // a pending milestone with no delivery for 14 days can be taken back (D-1)
const VOTE_BLOCKS = 14400 * 7;     // drawn reviewers have 7 days; then the votes cast decide (D-2)
const PRICE_INTERVAL = 600;
// Rules v3 (founder: "phải có 1 đường để phát triển"), from height V3_AT: while the founder grants alone (fewer than 4
// owners) nobody else could contest a grant, so waiting a day only stops work. A grant counts at once; pending grants
// count at V3_AT. From 4 owners on, the wait comes back (owners read and contest the evidence meanwhile).
const V3_AT = 3800;
const v3 = (s) => Number(s.height || 0) >= V3_AT;        // one price report per reporter per ~hour (D-3)
// A consensus key is exactly 32 bytes in CANONICAL base64: one key, one spelling (Codex P-4).
const isKey = (k) => typeof k === "string" && Buffer.from(k, "base64").length === 32 && Buffer.from(k, "base64").toString("base64") === k;

// Who holds a CometBFT vote: per owner, the bound AI with the lowest licence id → { pubKey: agent }.
function activeSet(s) {
  const best = {};
  for (const v of s.valset.validators) {
    const pk = s.binds[v.agent];
    if (!pk) continue;
    const id = s.licIds[v.agent];
    if (!best[v.holder] || id < best[v.holder].id) best[v.holder] = { id, agent: v.agent, pk };
  }
  const out = {};
  for (const b of Object.values(best)) out[b.pk] = b.agent;
  const c = s.caretaker;
  if (c && !c.retired && Object.keys(out).length < CARETAKER_UNTIL) out[c.pubKey] = c.agent;
  return out;
}

// ---------- the application ----------
class AGTApp {
  constructor(env = process.env) {
    this.stateFile = env.STATE_FILE || path.join(process.cwd(), "agt-state.json");
    this.agent = env.AGENT_KEY ? new ethers.Wallet(env.AGENT_KEY) : null;
    this.cmtRpc = env.CMT_RPC || "http://127.0.0.1:26657";
    this.bsc = env.BSC_VIEW || makeBscView(env); // tests inject a view
    this.state = fs.existsSync(this.stateFile) ? des(fs.readFileSync(this.stateFile, "utf8")) : null;
    this.check = this.state && structuredClone(this.state);
    this.work = null; // state being built in FinalizeBlock, persisted at Commit
    this.toAttest = [];
  }

  // ----- tx decoding & rules shared by CheckTx / ProcessProposal / FinalizeBlock -----
  decode(bytes) {
    const tx = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!tx || typeof tx.type !== "string") throw new Error("not an AGT tx");
    return tx;
  }

  applyAny(s, tx, { fromProposer = false } = {}) {
    if (tx.type === "licence-grant" || tx.type === "licence-revoke" || tx.type === "licence-cancel") {
      if (!s.ledger) throw new Error("licences live on the own ledger only");
      s.licences = s.licences || {};
      s.licNonce = s.licNonce || 0;
      if (Number(tx.nonce) !== s.licNonce) throw new Error("bad licence nonce");
      let body;
      if (tx.type === "licence-grant") {
        const l = tx.licence || {};
        if (!ethers.isAddress(l.agent) || !ethers.isAddress(l.holder)) throw new Error("bad licence addresses");
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(l.examHash)) || !/^0x[0-9a-fA-F]{64}$/.test(String(l.attestHash)) || /^0x0+$/.test(String(l.attestHash)))
          throw new Error("a licence carries the exam and the sealed-box attestation it was earned with");
        if (licOwners(s).length < CARETAKER_UNTIL && lower(l.holder) === ((s.ledger && s.ledger.granter) || FOUNDER)) throw new Error("the founder grants during the start, so he cannot license an AI of his own");
        if (Object.values(s.licences).some((x) => (x.active || x.pending) && x.agent === lower(l.agent))) throw new Error("that AI already holds a licence");
        const graders = Object.entries(s.graders || {}).filter(([, g]) => g.on).map(([k]) => k);
        if (graders.length) {
          const x = (s.exams || {})[String(l.examHash).toLowerCase()];
          const need = Math.min(GRADER_QUORUM, graders.length);
          const passes = x ? x.pass.filter((g) => graders.includes(g) && s.graders[g].holder !== lower(l.holder)).length : 0; // not its own owner's AI
          if (!x || x.agent !== lower(l.agent) || x.trade !== Number(l.trade) || passes < need || x.fail.some((g) => graders.includes(g)))
            throw new Error(`the exam is not passed on agt-1: ${passes} of ${need} graders signed a pass (and none a fail)`);
        }
        body = { agent: lower(l.agent), holder: lower(l.holder), trade: Number(l.trade), examHash: String(l.examHash).toLowerCase(), attestHash: String(l.attestHash).toLowerCase(), name: String(l.name || "").slice(0, 60) };
        // the sealed box's evidence (manifest with its client key), stored on agt-1 by content hash, so clients can
        // seal repository access to the box without asking any outside service
        if (l.evidence !== undefined) {
          if (!/^0x[0-9a-f]{64}$/.test(String(l.evidence).toLowerCase()) || !(s.content || {})[String(l.evidence).toLowerCase()]) throw new Error("the licence's evidence must be stored on agt-1 first (content-put)");
          body.evidence = String(l.evidence).toLowerCase();
        }
      } else body = { id: Number(tx.id) };
      if (!licAuthorised(s, licDigest(s.chainId, tx.type, body, s.licNonce), tx.sigs)) throw new Error("licence change not signed by those who may sign it now");
      s.licNonce++;
      if (tx.type === "licence-grant") {
        const id = (s.nextLicence = (s.nextLicence || 0) + 1);
        s.licences[id] = { ...body, active: false, pending: true, activeAt: Number(s.height || 0) + (v3(s) && granterActive(s) ? 0 : (s.ledger.licenceWait ?? LICENCE_WAIT)) };
      } else {
        const l = s.licences[body.id];
        if (!l) throw new Error("no such licence");
        if (tx.type === "licence-cancel" && !l.pending) throw new Error("only a pending grant can be cancelled");
        l.active = false;
        l.pending = false;
        ownValset(s);
      }
      return 0n;
    }
    if (tx.type === "trade-set") {
      if (!s.ledger) throw new Error("trades live on the own ledger only");
      const body = { trade: Number(tx.trade), name: String(tx.name || "").slice(0, 60), reward: String(BigInt(tx.reward)), reviewerReward: String(BigInt(tx.reviewerReward)), reviewers: Number(tx.reviewers), open: !!tx.open };
      if (!(body.trade > 0) || !(body.reviewers >= 1 && body.reviewers <= 9)) throw new Error("bad trade terms");
      s.licNonce = s.licNonce || 0;
      if (Number(tx.nonce) !== s.licNonce) throw new Error("bad licence nonce");
      if (!licAuthorised(s, licDigest(s.chainId, "trade-set", body, s.licNonce), tx.sigs)) throw new Error("trade terms not signed by those who may sign them now");
      s.licNonce++;
      (s.trades = s.trades || {})[body.trade] = body;
      return 0n;
    }
    if (tx.type === "work-submit") {
      if (!s.ledger) throw new Error("work lives on the own ledger only");
      const { who, fee } = workSigned(s, tx);
      const lic = licOf(s, who);
      if (!lic) throw new Error("only a licensed AI submits work");
      const t = (s.trades || {})[lic[1].trade];
      if (!t || !t.open) throw new Error("this trade takes no self-found work now");
      if (!/^0x[0-9a-f]{64}$/.test(String(tx.evidence))) throw new Error("work carries the hash of its evidence");
      const id = (s.nextJob = (s.nextJob || 0) + 1);
      (s.jobs = s.jobs || {})[id] = { worker: who, holder: lic[1].holder, trade: lic[1].trade, evidence: tx.evidence, drawAt: Number(s.height || 0) + 3, reviewers: null, votes: {}, status: "submitted" };
      return fee;
    }
    if (tx.type === "work-vote") {
      if (!s.ledger) throw new Error("work lives on the own ledger only");
      const j = (s.jobs || {})[Number(tx.job)];
      if (!j || j.status !== "drawn") throw new Error("no job waiting for votes");
      const granter = (s.ledger && s.ledger.granter) || FOUNDER;
      let who, fee = 0n;
      if (tx.asGranter) {
        const { sig, ...body } = tx;
        who = lower(ethers.verifyMessage(ethers.getBytes(workDigest(s.chainId, body, Number(tx.nonce))), sig));
        if (who !== granter) throw new Error("not the granter");
        s.nonces = s.nonces || {};
        if (Number(tx.nonce) !== (s.nonces[who] || 0)) throw new Error("bad nonce");
        s.nonces[who] = Number(tx.nonce) + 1;
      } else ({ who, fee } = workSigned(s, tx));
      if (!j.reviewers.includes(who)) throw new Error("not drawn for this job");
      if (who in j.votes) throw new Error("already voted");
      j.votes[who] = !!tx.approve;
      if (Object.keys(j.votes).length === j.reviewers.length) settleWork(s, j);
      return fee;
    }
    if (tx.type === "grader-set") {
      if (!s.ledger) throw new Error("graders live on the own ledger only");
      const body = { grader: lower(tx.grader), holder: lower(tx.holder || ethers.ZeroAddress), on: !!tx.on, attestHash: String(tx.attestHash || "") };
      s.licNonce = s.licNonce || 0;
      if (Number(tx.nonce) !== s.licNonce) throw new Error("bad licence nonce");
      if (!licAuthorised(s, licDigest(s.chainId, "grader-set", body, s.licNonce), tx.sigs)) throw new Error("grader change not signed by those who may sign it now");
      s.licNonce++;
      (s.graders = s.graders || {})[body.grader] = { on: body.on, holder: body.holder, attestHash: body.attestHash };
      return 0n;
    }
    if (tx.type === "exam-attest") {
      if (!s.ledger) throw new Error("exams live on the own ledger only");
      const e = { agent: lower(tx.agent), trade: Number(tx.trade), examHash: String(tx.examHash).toLowerCase(), passed: !!tx.passed };
      if (!/^0x[0-9a-f]{64}$/.test(e.examHash)) throw new Error("bad exam hash");
      const g = lower(ethers.verifyMessage(ethers.getBytes(examDigest(s.chainId, e)), tx.sig));
      if (!(s.graders || {})[g] || !s.graders[g].on) throw new Error("not a registered grader");
      const x = ((s.exams = s.exams || {})[e.examHash] = s.exams[e.examHash] || { agent: e.agent, trade: e.trade, pass: [], fail: [] });
      if (x.agent !== e.agent || x.trade !== e.trade) throw new Error("that exam belongs to another AI or trade");
      if (x.pass.includes(g) || x.fail.includes(g)) throw new Error("this grader already graded that exam");
      (e.passed ? x.pass : x.fail).push(g);
      return 0n;
    }
    if (tx.type === "content-put") {
      // Briefs, notes and CI reports live on agt-1 itself, addressed by keccak256 of their UTF-8 text: no outside
      // content service. A licensed AI uses its free quota; anyone else pays the fee. At most CONTENT_MAX bytes.
      if (!s.ledger) throw new Error("content lives on the own ledger only");
      const text = String(tx.text || "");
      if (!text || Buffer.byteLength(text) > CONTENT_MAX) throw new Error(`content must be 1 to ${CONTENT_MAX} bytes`);
      const { fee } = signedBy(s, tx, { free: !!licOf(s, who0(s, tx)) });
      const h = ethers.keccak256(ethers.toUtf8Bytes(text));
      (s.content = s.content || {})[h] = text;
      return fee;
    }
    if (tx.type === "seal-put") {
      // the client's repository token, sealed to the AI box's attested key (only that box can open it)
      if (!s.ledger) throw new Error("sealed access lives on the own ledger only");
      const { who, fee } = signedBy(s, tx);
      const e = (s.engs || {})[Number(tx.eng)];
      if (!e || e.client !== who) throw new Error("only the contract's client seals access for it");
      const box = JSON.stringify(tx.box || null);
      if (box.length > 4096 || !tx.box) throw new Error("bad sealed box");
      (s.sealed = s.sealed || {})[Number(tx.eng)] = tx.box;
      return fee;
    }
    if (tx.type === "eng-open") {
      if (!s.ledger) throw new Error("contracts live on the own ledger only");
      const { who, fee } = signedBy(s, tx);
      const l = (s.licences || {})[Number(tx.licence)];
      if (!l || !l.active) throw new Error("that licence is not active");
      if (l.holder === who) throw new Error("an owner does not hire its own AI");
      if (!/^0x[0-9a-f]{64}$/.test(String(tx.brief))) throw new Error("a contract names the hash of its brief");
      const ms = (tx.milestones || []).map((a) => BigInt(a));
      if (!ms.length || ms.length > 24 || ms.some((a) => a <= 0n)) throw new Error("1 to 24 milestones, each paid more than 0");
      const total = ms.reduce((a, b) => a + b, 0n);
      if ((s.balances[who] || 0n) < total) throw new Error("the client must lock every milestone now");
      s.balances[who] -= total;
      const id = (s.nextEng = (s.nextEng || 0) + 1);
      (s.engs = s.engs || {})[id] = { client: who, worker: l.agent, holder: l.holder, trade: l.trade, brief: tx.brief, escrow: total.toString(), started: false, ...(v2(s) ? { openedAt: Number(s.height || 0) } : {}), milestones: ms.map((a) => ({ amount: a.toString(), state: "pending", revisions: 0, ...(v2(s) ? { since: Number(s.height || 0) } : {}) })) };
      return fee;
    }
    if (tx.type === "eng-deliver" || tx.type === "eng-accept" || tx.type === "eng-revise" || tx.type === "eng-dispute" || tx.type === "eng-cancel" || tx.type === "eng-vote" || tx.type === "eng-reclaim") {
      if (!s.ledger) throw new Error("contracts live on the own ledger only");
      const e = (s.engs || {})[Number(tx.eng)];
      if (!e) throw new Error("no such contract");
      const m = Number(tx.milestone), x = e.milestones[m];
      if (tx.type !== "eng-cancel" && !x) throw new Error("no such milestone");
      if (tx.type === "eng-deliver") {
        const { who, fee } = signedBy(s, tx, { free: true });
        if (who !== e.worker) throw new Error("only the hired AI delivers");
        if (x.state !== "pending") throw new Error("that milestone is not waiting for a delivery");
        if (!/^0x[0-9a-f]{40,64}$/.test(String(tx.commit)) || !/^0x[0-9a-f]{64}$/.test(String(tx.ci))) throw new Error("a delivery names its commit and its CI report");
        Object.assign(x, { state: "delivered", commit: tx.commit, ci: tx.ci, deliveredAt: Number(s.height || 0) });
        e.started = true;
        return fee;
      }
      if (tx.type === "eng-vote") {
        const { who, fee } = signedBy(s, tx, { free: true });
        if (x.state !== "disputed" || !x.reviewers || !x.reviewers.includes(who)) throw new Error("not drawn for this dispute");
        x.votes = x.votes || {};
        if (who in x.votes) throw new Error("already voted");
        x.votes[who] = !!tx.workerRight;
        if (Object.keys(x.votes).length === x.reviewers.length) payMilestone(s, e, m, Object.values(x.votes).filter(Boolean).length * 2 > x.reviewers.length);
        return fee;
      }
      const { who, fee } = signedBy(s, tx, { free: who0(s, tx) === e.worker });
      if (tx.type === "eng-reclaim") {
        if (!v2(s)) throw new Error("eng-reclaim starts with rules v2");
        if (who !== e.client || !x || x.state !== "pending") throw new Error("only the client takes back a pending milestone");
        const since = Number(x.since ?? e.openedAt ?? 0);
        if (Number(s.height || 0) < since + RECLAIM_BLOCKS) throw new Error("the AI still has time for this milestone");
        payMilestone(s, e, m, false);
        return fee;
      }
      if (tx.type === "eng-cancel") {
        if (who !== e.client || e.started) throw new Error("only the client cancels, and only before the first delivery");
        e.milestones.forEach((y, i) => { if (y.state === "pending") payMilestone(s, e, i, false); });
        e.cancelled = true;
        return fee;
      }
      if (tx.type === "eng-accept") {
        if (who !== e.client || x.state !== "delivered") throw new Error("only the client accepts a delivered milestone");
        payMilestone(s, e, m, true);
        return fee;
      }
      if (tx.type === "eng-revise") {
        if (who !== e.client || x.state !== "delivered") throw new Error("only the client asks a revision of a delivered milestone");
        if (x.revisions >= MAX_REVISIONS) throw new Error("no revisions left: accept or dispute");
        if (!/^0x[0-9a-f]{64}$/.test(String(tx.note))) throw new Error("a revision names the hash of its note");
        Object.assign(x, { state: "pending", revisions: x.revisions + 1, note: tx.note, ...(v2(s) ? { since: Number(s.height || 0) } : {}) });
        return fee;
      }
      if (tx.type === "eng-dispute") {
        if (who !== e.client && who !== e.worker) throw new Error("only the client or the AI disputes");
        if (x.state !== "delivered" && !(x.state === "pending" && x.revisions >= MAX_REVISIONS)) throw new Error("nothing to dispute on that milestone");
        Object.assign(x, { state: "disputed", drawAt: Number(s.height || 0) + 3, reviewers: null, votes: {} });
        return fee;
      }
    }
    if (tx.type === "price-report") {
      if (!s.ledger) throw new Error("prices live on the own ledger only");
      const who = lower(tx.reporter), price = BigInt(tx.price), asset = String(tx.asset);
      if (!/^([0-9]+|btc):(native|0x[0-9a-f]{40})$/.test(asset)) throw new Error("bad asset name");
      if (price <= 0n) throw new Error("bad price");
      if (!priceReporterOk(s, who)) throw new Error("not a price reporter: a licensed AI, or the granter at the start");
      s.prices = s.prices || {};
      const a = (s.prices[asset] = s.prices[asset] || { reports: {}, nonces: {} });
      const nonce = a.nonces[who] || 0;
      if (Number(tx.nonce) !== nonce) throw new Error("bad price nonce");
      if (v2(s)) {
        a.at = a.at || {}; // v1 state has no "at": created only from V2_AT, so older blocks replay unchanged
        if (a.at[who] !== undefined && Number(s.height || 0) < a.at[who] + PRICE_INTERVAL) throw new Error(`one price report per reporter every ${PRICE_INTERVAL} blocks`);
      }
      if (lower(ethers.verifyMessage(ethers.getBytes(priceDigest(s.chainId, asset, price.toString(), nonce)), tx.sig)) !== who) throw new Error("price report not signed by its reporter");
      const now = priceOf(s, asset);
      if (now > 0n && (price * 10000n > now * (10000n + PRICE_STEP_BPS) || price * 10000n < now * (10000n - PRICE_STEP_BPS))) throw new Error("price report too far from the current median (±10%)");
      a.reports[who] = price.toString();
      if (v2(s)) a.at[who] = Number(s.height || 0);
      a.nonces[who] = nonce + 1;
      return 0n;
    }
    if (tx.type === "kho-credit") {
      // AGT for coins deposited in a Kho (they remain there; nobody can take them out). Proposer-only; every
      // validator re-checked it in ProcessProposal against its own view of the origin chain.
      if (!s.ledger) throw new Error("Kho deposits mint AGT only on the own ledger");
      if (!fromProposer) throw new Error("Kho credits only come from the proposer");
      const k = tx.chain === "btc" ? KHO_BTC : KHO[Number(tx.chain)];
      if (!k) throw new Error("no Kho on that chain");
      if (!ethers.isAddress(tx.beneficiary)) throw new Error("bad agt-1 account");
      const id = `${tx.chain === "btc" ? "btc" : Number(tx.chain)}:${String(tx.txHash).toLowerCase()}:${Number(tx.logIndex)}`;
      s.khoCredited = s.khoCredited || {};
      if (s.khoCredited[id]) throw new Error("deposit already credited");
      const price = priceOf(s, k.asset);
      if (price <= 0n) throw new Error("no agt-1 price for this asset yet");
      const agt = (BigInt(tx.amount) * price) / 10n ** BigInt(k.decimals), to = lower(tx.beneficiary);
      if (agt <= 0n) throw new Error("deposit worth nothing");
      s.khoCredited[id] = { block: Number(tx.block), amount: String(tx.amount), agt: agt.toString(), to };
      s.balances[to] = (s.balances[to] || 0n) + agt;
      s.supply += agt;
      s.khoMinted = (s.khoMinted || 0n) + agt;
      return 0n;
    }
    if (s.ledger) {
      if (["credit", "attest", "withdraw"].includes(tx.type)) throw new Error("AGT lives on this chain: there is no BSC bridge");
    } else if (s.provisional && !["valset", "bind"].includes(tx.type)) throw new Error("provisional chain: no balances, no transfers, no withdrawals");
    if (tx.type === "credit") {
      if (!fromProposer) throw new Error("credits only come from the proposer");
      if (Number(tx.nonce) !== s.nextIn) throw new Error("credits out of order");
      const to = lower(tx.to), amount = BigInt(tx.amount);
      if (amount <= 0n) throw new Error("bad credit");
      s.balances[to] = (s.balances[to] || 0n) + amount;
      s.supply += amount;
      s.nextIn++;
      return 0n;
    }
    if (tx.type === "attest") {
      const w = s.outbox[tx.nonce];
      if (!w) throw new Error("no such withdrawal");
      const agent = lower(tx.agent);
      if (!s.valset.validators.some((v) => v.agent === agent)) throw new Error("not a validator AI");
      const d = C.releaseDigestRaw(s.bsc.chainId, s.bsc.bridge, Number(tx.nonce), w.to, w.amount);
      if (lower(ethers.verifyMessage(ethers.getBytes(d), tx.sig)) !== agent) throw new Error("bad release signature");
      s.attest[tx.nonce] = s.attest[tx.nonce] || {};
      if (s.attest[tx.nonce][agent]) throw new Error("already attested");
      s.attest[tx.nonce][agent] = tx.sig;
      return 0n; // attesting is part of the signing work; the wage covers it
    }
    if (tx.type === "valset" && s.ledger) throw new Error("licences live on this chain: BSC snapshots no longer count");
    if (tx.type === "valset") {
      // New licence snapshot from BSC (proposer-only; every validator re-reads BSC at tx.bscBlock).
      if (!fromProposer) throw new Error("validator sets only come from the proposer");
      if (Number(tx.bscBlock) < s.bscBlock) throw new Error("snapshot older than the current one");
      const v = normSnap(tx);
      s.valset = C.normValset(v);
      s.licIds = Object.fromEntries(v.validators.map((x) => [x.agent, x.id]));
      s.bscBlock = Number(tx.bscBlock);
      return 0n;
    }
    if (tx.type === "bind") {
      // A licensed AI declares which CometBFT consensus key it runs, signed with its licence key.
      const agent = lower(tx.agent);
      const v = s.valset.validators.find((x) => x.agent === agent);
      if (!v) throw new Error("not a licensed AI in a sealed box");
      if (!isKey(tx.pubKey)) throw new Error("bad ed25519 key");
      if (s.caretaker && tx.pubKey === s.caretaker.pubKey) throw new Error("that is the caretaker's key"); // Codex P-2
      if (lower(ethers.verifyMessage(ethers.getBytes(bindDigest(s.chainId, tx.pubKey)), tx.sig)) !== agent) throw new Error("binding not signed by the AI's licence key");
      if (s.binds[agent] === tx.pubKey) throw new Error("already bound");
      if (Object.entries(s.binds).some(([a, pk]) => pk === tx.pubKey && a !== agent)) throw new Error("key bound by another AI");
      s.binds[agent] = tx.pubKey;
      s.cmt[cmtAddress(tx.pubKey)] = { agent, holder: v.holder, pubKey: tx.pubKey };
      return 0n;
    }
    return C.applyTx(s, tx); // transfer / withdraw / setFee — returns the wage paid
  }

  // ----- ABCI -----
  Info() {
    const s = this.state;
    return { data: "AGT chain", version: "0.1.0", app_version: "1", last_block_height: String(s ? s.height : 0), last_block_app_hash: s ? appHash(s) : Buffer.alloc(0) };
  }

  InitChain(req) {
    const raw = Buffer.from(req.app_state_bytes).toString("utf8");
    if (!raw) throw new Error("genesis has no AGT app_state (validators, BSC bridge) — wrong genesis file");
    const g = JSON.parse(raw);
    const provisional = g.provisional === true;
    if (g.ledger && !provisional) throw new Error("an own ledger starts only on a provisional chain");
    if (!g.bsc || !ethers.isAddress(g.bsc.bridge)) throw new Error("genesis names no valid bridge address");
    if (g.caretaker && !provisional) throw new Error("a caretaker validator is allowed only on a provisional chain");
    // provisional ⇔ no bridge (Codex P-3): a chain with balances names its bridge; a provisional one names none
    if (provisional !== (lower(g.bsc.bridge) === ethers.ZeroAddress)) throw new Error("a provisional chain carries no balances (zero bridge), and only a provisional chain may have a zero bridge");
    if (g.caretaker && !isKey(g.caretaker.pubKey)) throw new Error("bad caretaker ed25519 key");
    const keys = [...g.validators.map((v) => v.pubKey), ...(g.caretaker ? [g.caretaker.pubKey] : [])];
    if (keys.some((k) => !isKey(k)) || new Set(keys).size !== keys.length) throw new Error("genesis consensus keys must be valid and all different"); // Codex P-2
    if (!g.validators.length && !g.caretaker) throw new Error("no validator at genesis");
    // AGT's own ledger (docs/decisions/2026-11-22-own-ledger-now.md): opening balances = a published snapshot of AGT
    // on BSC at one block; from then on AGT lives here: no BSC bridge, fees in AGT. Only on a provisional chain.
    const opening = {};
    if (g.ledger) {
      const sn = g.ledger.snapshot || {};
      if (!Number.isInteger(sn.bscBlock) || !ethers.isAddress(sn.token)) throw new Error("the ledger names no BSC snapshot (token, block)");
      for (const [a, v] of Object.entries(g.ledger.balances || {})) {
        if (!ethers.isAddress(a) || BigInt(v) <= 0n) throw new Error(`bad opening balance for ${a}`);
        opening[lower(a)] = (opening[lower(a)] || 0n) + BigInt(v);
      }
    }
    const owners = new Set();
    const cmt = {};
    for (const v of g.validators) {
      const agent = lower(v.agent), holder = lower(v.holder);
      if (owners.has(holder)) throw new Error(`owner ${holder} has two validators — 1 owner = 1 vote`);
      owners.add(holder);
      if (lower(ethers.verifyMessage(ethers.getBytes(bindDigest(req.chain_id, v.pubKey)), v.bindSig)) !== agent)
        throw new Error(`validator ${agent}: binding not signed by the AI's licence key`);
      cmt[cmtAddress(v.pubKey)] = { agent, holder, pubKey: v.pubKey };
    }
    const s = C.genesis({ chainId: req.chain_id, bsc: g.bsc, valset: { holders: g.holders, validators: g.validators } });
    s.provisional = provisional;
    s.ledger = g.ledger ? { snapshot: { token: lower(g.ledger.snapshot.token), bscBlock: g.ledger.snapshot.bscBlock }, ...(Number.isInteger(g.ledger.licenceWait) ? { licenceWait: g.ledger.licenceWait } : {}), granter: g.ledger.granter ? lower(g.ledger.granter) : FOUNDER } : null;
    s.balances = opening;
    s.supply = Object.values(opening).reduce((t, v) => t + v, 0n);
    s.burned = 0n;
    // carried over from an earlier AGT ledger (agt-1 → agt-2): which Kho deposits were already credited, so that none
    // is ever credited twice, and how much AGT the Kho has minted (it raises the work caps)
    if (g.ledger && g.ledger.khoCredited) {
      s.khoCredited = {};
      for (const [id, c] of Object.entries(g.ledger.khoCredited)) s.khoCredited[String(id).toLowerCase()] = c;
      s.khoMinted = BigInt(g.ledger.khoMinted || 0);
    }
    // Consensus rules are versioned: a change of rules takes effect at a published height, so that anyone can replay
    // the chain from genesis with the current code (tools/agt1-follow.js). agt-1 broke this and was replaced by agt-2.
    s.rules = 1;
    s.caretaker = g.caretaker ? { pubKey: g.caretaker.pubKey, agent: "caretaker:" + String(g.caretaker.label || "founder").slice(0, 40), retired: false } : null;
    if (s.caretaker) cmt[cmtAddress(s.caretaker.pubKey)] = { agent: s.caretaker.agent, holder: "caretaker", pubKey: s.caretaker.pubKey };
    s.cmt = cmt;
    s.binds = Object.fromEntries(Object.values(cmt).map((v) => [v.agent, v.pubKey]));
    s.licIds = Object.fromEntries(g.validators.map((v, i) => [lower(v.agent), Number(v.id ?? i + 1)]));
    s.bscBlock = Number(g.bscBlock || 0);
    s.active = activeSet(s);
    s.attest = {};
    s.pendingWage = 0n;
    this.state = s;
    this.check = structuredClone(s);
    log(`InitChain ${req.chain_id}: ${g.validators.length} AI validators, ${g.holders} owners${s.ledger ? ` · OWN LEDGER, ${Object.keys(opening).length} opening balances` : provisional ? " · PROVISIONAL (no balances)" : ""}${s.caretaker ? " · caretaker " + s.caretaker.agent : ""}`);
    return {
      consensus_params: null,
      validators: Object.keys(s.active).map((pk) => ({ pub_key: { ed25519: Buffer.from(pk, "base64") }, power: "1" })), // 1 owner = 1 vote
      app_hash: appHash(s),
    };
  }

  CheckTx(req) {
    try {
      const tx = this.decode(req.tx);
      const t = structuredClone(this.check); // a rejected tx leaves no trace (Codex A-5)
      this.applyAny(t, tx);
      this.check = t;
      return { code: OK };
    } catch (e) {
      return { code: BAD, log: e.message };
    }
  }

  refreshKho() {
    this.khoSeen = this.khoSeen || { at: 0, busy: false, evm: [], btc: [] };
    const k = this.khoSeen;
    if (k.busy) return k.job;
    if (Date.now() - k.at < 60000) return null;
    k.busy = true;
    return (k.job = (async () => {
      try { if (this.bsc.khoDeposits) k.evm = (await this.bsc.khoDeposits(KHO[97].fromBlock)).deposits; } catch (e) { log("Kho view unavailable:", e.message); }
      try { if (this.bsc.btcDeposits) k.btc = await this.bsc.btcDeposits(); } catch (e) { log("Bitcoin view unavailable:", e.message); }
      k.at = Date.now(); k.busy = false;
    })());
  }

  async PrepareProposal(req) {
    const s = structuredClone(this.state);
    const out = [];
    let size = 0;
    const push = (b) => {
      if (size + b.length > Number(req.max_tx_bytes)) return false;
      out.push(b);
      size += b.length;
      return true;
    };
    if (!s.ledger) try {
      const head = await this.bsc.head();
      const snap = await this.bsc.valsetAt(head);
      if (snap && head >= s.bscBlock && !sameSnap(snap, snapOfState(s))) {
        const tx = { type: "valset", bscBlock: head, ...normSnap(snap) };
        this.applyAny(s, tx, { fromProposer: true });
        push(Buffer.from(JSON.stringify(tx)));
      }
    } catch (e) {
      log("BSC licences unavailable, keeping the current validator set:", e.message);
    }
    // the Kho views are scanned in the background (never while a block waits): proposing stays fast; each credit is
    // still checked one by one by every validator in ProcessProposal. Not consensus: only what the proposer offers.
    if (s.ledger) { const first = !this.khoSeen || !this.khoSeen.at; const job = this.refreshKho(); if (first && job) await job; } // only the very first scan is awaited
    if (s.ledger && this.khoSeen.evm.length) try {
      for (const d of this.khoSeen.evm) {
        if ((s.khoCredited || {})[`${d.chain}:${d.txHash.toLowerCase()}:${d.logIndex}`]) continue;
        if (priceOf(s, KHO[d.chain].asset) <= 0n) break; // no agt-1 price yet: the deposit waits, nothing is lost
        const tx = { type: "kho-credit", ...d };
        this.applyAny(s, tx, { fromProposer: true });
        if (!push(Buffer.from(JSON.stringify(tx)))) break;
      }
    } catch (e) {
      log("Kho view unavailable, proposing without Kho credits:", e.message);
    }
    if (s.ledger && this.khoSeen.btc.length) try {
      for (const d of this.khoSeen.btc) {
        if ((s.khoCredited || {})[`btc:${d.txHash.toLowerCase()}:${d.logIndex}`]) continue;
        if (priceOf(s, KHO_BTC.asset) <= 0n) break;
        const tx = { type: "kho-credit", ...d };
        this.applyAny(s, tx, { fromProposer: true });
        if (!push(Buffer.from(JSON.stringify(tx)))) break;
      }
    } catch (e) {
      log("Bitcoin view unavailable, proposing without Bitcoin Kho credits:", e.message);
    }
    if (!s.provisional) try {
      for (const l of await this.bsc.locksFrom(s.nextIn)) {
        if (l.nonce !== s.nextIn) break;
        const tx = { type: "credit", nonce: l.nonce, to: l.to, amount: l.amount.toString() };
        this.applyAny(s, tx, { fromProposer: true });
        if (!push(Buffer.from(JSON.stringify(tx)))) break;
      }
    } catch (e) {
      log("BSC view unavailable, proposing without credits:", e.message);
    }
    for (const b of req.txs) {
      try {
        const tx = this.decode(b);
        if (tx.type === "credit") continue;
        const t = structuredClone(s);
        this.applyAny(t, tx);
        this.applyAny(s, tx);
        if (!push(b)) break;
      } catch {
        /* drop invalid */
      }
    }
    return { txs: out };
  }

  async ProcessProposal(req) {
    const s = structuredClone(this.state);
    try {
      let locks = null;
      for (const b of req.txs) {
        const tx = this.decode(b);
        if (tx.type === "valset") {
          if (Number(tx.bscBlock) > (await this.bsc.head())) throw new Error(`snapshot from BSC block ${tx.bscBlock} is not final for me yet`);
          const mine = await this.bsc.valsetAt(Number(tx.bscBlock));
          if (!mine || !sameSnap(mine, tx)) throw new Error(`licence snapshot at BSC block ${tx.bscBlock} does not match BSC`);
        }
        if (tx.type === "kho-credit") {
          const mine = tx.chain === "btc" ? (this.bsc.btcDeposit ? await this.bsc.btcDeposit(tx) : null) : this.bsc.khoDeposit ? await this.bsc.khoDeposit(tx) : null;
          if (!mine) throw new Error(`Kho deposit ${tx.txHash} not final or not seen by me`);
          for (const f of ["block", "from", "beneficiary", "amount"]) if (String(mine[f]) !== String(f === "block" ? Number(tx[f]) : f === "beneficiary" || (f === "from" && tx.chain !== "btc") ? lower(tx[f]) : tx[f])) throw new Error(`Kho deposit ${tx.txHash}: ${f} differs from my view`);
        }
        if (tx.type === "credit") {
          locks = locks || (await this.bsc.locksFrom(s.nextIn));
          const l = locks.find((x) => x.nonce === Number(tx.nonce));
          if (!l || l.to !== lower(tx.to) || l.amount !== BigInt(tx.amount)) throw new Error(`credit ${tx.nonce} not seen on BSC`);
        }
        this.applyAny(s, tx, { fromProposer: true });
      }
      return { status: "ACCEPT" };
    } catch (e) {
      log(`REJECT proposal at height ${req.height}: ${e.message}`);
      return { status: "REJECT" };
    }
  }

  FinalizeBlock(req) {
    const s = structuredClone(this.state);
    const events = [];

    // 1. Wage of the PREVIOUS block → owners whose AIs signed it (CometBFT tells us exactly who did).
    if (s.pendingWage > 0n) {
      const owners = [...new Set(req.decided_last_commit.votes
        .filter((v) => v.block_id_flag === "BLOCK_ID_FLAG_COMMIT")
        .map((v) => s.cmt[Buffer.from(v.validator.address).toString("hex")])
        .map((c) => (c && v2(s) && c.holder !== "caretaker" ? (() => { const cur = s.valset.validators.find((x) => x.agent === c.agent); return cur ? { ...c, holder: cur.holder } : null; })() : c))
        .filter(Boolean)
        .map((v) => v.holder)
        .filter((h) => h !== "caretaker"))].sort();
      if (owners.length) {
        const share = s.pendingWage / BigInt(owners.length);
        owners.forEach((o, i) => {
          const pay = share + (i === 0 ? s.pendingWage - share * BigInt(owners.length) : 0n);
          s.balances[o] = (s.balances[o] || 0n) + pay;
          s.wages[o] = (s.wages[o] || 0n) + pay;
        });
        s.pendingWage = 0n;
      } else if (s.ledger) {
        s.supply -= s.pendingWage; // only the caretaker signed: the fee is burned, nobody profits from holding the role
        s.burned += s.pendingWage;
        s.pendingWage = 0n;
      }
    }

    // 2. Transactions.
    const before = s.nextOut;
    const tx_results = req.txs.map((b) => {
      try {
        const tx = this.decode(b);
        const t = structuredClone(s);
        const wage = this.applyAny(t, tx, { fromProposer: true });
        Object.assign(s, t);
        s.pendingWage += wage;
        return { code: OK, gas_wanted: "0", gas_used: "0", events: [] };
      } catch (e) {
        return { code: BAD, log: e.message, gas_wanted: "0", gas_used: "0", events: [] };
      }
    });
    for (let n = before; n < s.nextOut; n++) {
      events.push({ type: "withdraw", attributes: [{ key: "nonce", value: String(n), index: true }, { key: "to", value: s.outbox[n].to, index: true }, { key: "amount", value: s.outbox[n].amount.toString(), index: false }] });
      this.toAttest.push(n);
    }

    // 3. Validator set follows the licences: add newly bound AIs, remove revoked ones (power 0).
    if (s.ledger && s.jobs) {
      const bh = ethers.hexlify(req.hash && req.hash.length ? req.hash : ethers.zeroPadValue("0x", 32));
      for (const [id, j] of Object.entries(s.jobs)) {
        if ((j.status === "submitted" && Number(req.height) >= j.drawAt) || j.status === "waiting-reviewers") { drawReviewers(s, j, Number(id), bh); if (v2(s)) j.drawnAt = Number(req.height); }
        else if (v2(s) && j.status === "drawn" && Number(req.height) >= Number(j.drawnAt ?? j.drawAt) + VOTE_BLOCKS) {
          if (Object.keys(j.votes).length) { j.reviewers = Object.keys(j.votes); settleWork(s, j); } // the votes cast decide
          else j.status = "expired"; // nobody voted: nothing is minted
        }
      }
    }
    if (s.ledger && s.engs) {
      const bh2 = ethers.hexlify(req.hash && req.hash.length ? req.hash : ethers.zeroPadValue("0x", 32));
      for (const [id, e] of Object.entries(s.engs)) e.milestones.forEach((x, m) => {
        if (x.state === "delivered" && Number(req.height) >= x.deliveredAt + REVIEW_BLOCKS) payMilestone(s, e, m, true); // silence accepts
        if (x.state === "disputed" && x.reviewers && !x.reviewers.length) x.reviewers = null; // retry the draw (Codex A-1)
        if (v2(s) && x.state === "disputed" && x.reviewers && x.reviewers.length && Number(req.height) >= Number(x.drawnAt ?? x.drawAt) + VOTE_BLOCKS) {
          const votes = Object.values(x.votes || {});
          const yes = votes.filter(Boolean).length, no = votes.length - yes;
          if (yes !== no) payMilestone(s, e, m, yes > no);
          else { // no votes, or a tie: split, never stuck
            const half = BigInt(x.amount) / 2n;
            s.balances[e.holder] = (s.balances[e.holder] || 0n) + half;
            s.balances[e.client] = (s.balances[e.client] || 0n) + (BigInt(x.amount) - half);
            e.escrow = (BigInt(e.escrow) - BigInt(x.amount)).toString();
            x.state = "split";
          }
          return;
        }
        if (x.state === "disputed" && !x.reviewers && Number(req.height) >= x.drawAt + REVIEW_BLOCKS) {
          const half = BigInt(x.amount) / 2n; // nobody could judge for a long time: split, never stuck
          s.balances[e.holder] = (s.balances[e.holder] || 0n) + half;
          s.balances[e.client] = (s.balances[e.client] || 0n) + (BigInt(x.amount) - half);
          e.escrow = (BigInt(e.escrow) - BigInt(x.amount)).toString();
          x.state = "split";
          return;
        }
        if (x.state === "disputed" && !x.reviewers && Number(req.height) >= x.drawAt) {
          const tmp = { trade: e.trade, holder: e.holder, client: e.client, reviewers: null, status: "" };
          drawReviewers(s, tmp, Number(id) * 1000 + m, bh2, ((s.trades || {})[e.trade] || { reviewers: 3 }).reviewers);
          x.reviewers = tmp.reviewers;
          if (v2(s)) x.drawnAt = Number(req.height);
        }
      });
    }
    if (s.ledger) payWorkQueue(s);
    if (s.ledger && v2(s) && !s.handedOver && licOwners(s).length >= CARETAKER_UNTIL) s.handedOver = true; // one way (D-4)
    if (s.ledger && s.licences) {
      let changed = false;
      for (const l of Object.values(s.licences)) if (l.pending && (s.height >= l.activeAt || (v3(s) && granterActive(s)))) { l.pending = false; l.active = true; changed = true; }
      if (changed) ownValset(s);
      if (changed && v2(s) && !s.handedOver && licOwners(s).length >= CARETAKER_UNTIL) s.handedOver = true; // latch in the same block the 4th owner activates (Codex review of v2)
    }
    const next = activeSet(s);
    if (s.caretaker && !s.caretaker.retired && !(s.caretaker.pubKey in next)) s.caretaker.retired = true; // one way
    // No legitimate validator left (every licence revoked, caretaker gone): never keep revoked ones signing
    // (Codex P-1). Every node reaches this in the same block and stops; the remedy is a new public genesis.
    if (!Object.keys(next).length) throw new Error("no licensed validator left: the chain halts here by design — restart from a new public genesis");
    const validator_updates = [];
    {
      for (const pk of Object.keys(s.active)) if (!(pk in next)) validator_updates.push({ pub_key: { ed25519: Buffer.from(pk, "base64") }, power: "0" });
      for (const pk of Object.keys(next)) if (!(pk in s.active)) validator_updates.push({ pub_key: { ed25519: Buffer.from(pk, "base64") }, power: "1" });
      s.active = next;
      validator_updates.sort((x, y) => Buffer.compare(x.pub_key.ed25519, y.pub_key.ed25519)); // fixed order (Gemini P-5)
    }
    for (const u of validator_updates) {
      const pk = u.pub_key.ed25519.toString("base64");
      events.push({ type: "validator", attributes: [{ key: "agent", value: s.cmt[cmtAddress(pk)].agent, index: true }, { key: "power", value: u.power, index: false }] });
      log(`validator ${u.power === "1" ? "added" : "removed"}: ${s.cmt[cmtAddress(pk)].agent}`);
    }

    s.height = Number(req.height);
    s.lastHash = "0x" + Buffer.from(req.hash).toString("hex");
    this.work = s;
    return { events, tx_results, validator_updates, consensus_param_updates: null, app_hash: appHash(s) };
  }

  Commit() {
    this.state = this.work;
    this.work = null;
    fs.writeFileSync(this.stateFile + ".tmp", ser(this.state));
    fs.renameSync(this.stateFile + ".tmp", this.stateFile);
    this.check = structuredClone(this.state);
    setImmediate(() => this.attestPending());
    setImmediate(() => this.bindIfNeeded());
    return { retain_height: "0" };
  }

  // A newly licensed AI binds this node's CometBFT key (read from its own CometBFT) with its licence key.
  async bindIfNeeded() {
    if (!this.agent || this.binding) return;
    const me = lower(this.agent.address);
    if (!this.state.valset.validators.some((v) => v.agent === me)) return;
    this.binding = true;
    try {
      const st = await (await fetch(`${this.cmtRpc}/status`)).json();
      const pk = st.result.validator_info.pub_key.value;
      if (this.state.binds[me] === pk) return;
      const sig = await this.agent.signMessage(ethers.getBytes(bindDigest(this.state.chainId, pk)));
      const hex = "0x" + Buffer.from(JSON.stringify({ type: "bind", agent: me, pubKey: pk, sig })).toString("hex");
      const r = await (await fetch(`${this.cmtRpc}/broadcast_tx_sync?tx=${hex}`)).json();
      log(`bind consensus key ${pk.slice(0, 10)}…: ${r.result && r.result.code === 0 ? "sent" : JSON.stringify(r.result || r.error)}`);
    } catch (e) {
      log(`bind failed (${e.message}); will retry`);
    } finally {
      setTimeout(() => (this.binding = false), 5000);
    }
  }

  // This node's AI signs each new withdrawal and gossips the signature as a tx.
  async attestPending() {
    if (!this.agent) return;
    const me = lower(this.agent.address);
    while (this.toAttest.length) {
      const n = this.toAttest.shift();
      const w = this.state.outbox[n];
      if (!w || (this.state.attest[n] && this.state.attest[n][me])) continue;
      const sig = await this.agent.signMessage(ethers.getBytes(C.releaseDigestRaw(this.state.bsc.chainId, this.state.bsc.bridge, n, w.to, w.amount)));
      const hex = "0x" + Buffer.from(JSON.stringify({ type: "attest", nonce: n, agent: me, sig })).toString("hex");
      try {
        const r = await (await fetch(`${this.cmtRpc}/broadcast_tx_sync?tx=${hex}`)).json();
        log(`attested withdrawal #${n}: ${r.result && r.result.code === 0 ? "ok" : JSON.stringify(r.result || r.error)}`);
      } catch (e) {
        log(`attest #${n} failed (${e.message}); retrying later`);
        this.toAttest.push(n);
        setTimeout(() => this.attestPending(), 3000);
        return;
      }
    }
  }

  Query(req) {
    const s = this.state;
    const reply = (v) => ({ code: OK, value: Buffer.from(ser(v)), height: String(s ? s.height : 0) });
    if (!s) return { code: BAD, log: "not initialised" };
    const p = req.path;
    if (p === "/state")
      return reply({ chainId: s.chainId, height: s.height, fee: s.fee, maxFee: C.MAX_FEE, supply: s.supply, nextIn: s.nextIn, nextOut: s.nextOut, owners: s.valset.holders, validators: s.valset.validators.map((v) => ({ ...v, licence: s.licIds[v.agent], bound: !!s.binds[v.agent], vote: Object.values(s.active).includes(v.agent) })), bscBlock: s.bscBlock, wages: s.wages, bsc: s.bsc });
    if (p === "/engs") return reply(s.engs || {});
    if (p === "/exams") return reply({ graders: s.graders || {}, exams: s.exams || {} });
    if (p.startsWith("/content/")) return reply({ text: (s.content || {})[p.slice(9).toLowerCase()] ?? null });
    if (p.startsWith("/sealed/")) return reply({ box: (s.sealed || {})[Number(p.slice(8))] ?? null });
    if (p === "/jobs") return reply(s.jobs || {});
    if (p === "/ledger") return reply({ licNonce: s.licNonce || 0, trades: s.trades || {}, licences: s.licences || {}, jobs: s.nextJob || 0, contracts: s.nextEng || 0, workMinted: s.workMinted || 0n, khoMinted: s.khoMinted || 0n, workQueue: (s.workQueue || []).length, granter: s.ledger && s.ledger.granter });
    if (p.startsWith("/price/")) {
      const asset = p.slice(7);
      const a = (s.prices || {})[asset] || { reports: {}, nonces: {} };
      return reply({ asset, price: priceOf(s, asset), reports: a.reports, nonces: a.nonces });
    }
    if (p.startsWith("/balance/")) {
      const a = lower(p.slice(9));
      return reply({ address: AGTAddress.toAgt(a), hex: a, balance: s.balances[a] || 0n, nonce: s.nonces[a] || 0 });
    }
    if (p.startsWith("/release/")) {
      // Ready-to-submit package for AGTBridge.release(): one signature per owner, sorted by owner address.
      const n = Number(p.slice(9));
      const w = s.outbox[n];
      if (!w) return { code: BAD, log: "no such withdrawal" };
      const ownerOf = new Map(s.valset.validators.map((v) => [v.agent, v.holder]));
      const sigs = Object.entries(s.attest[n] || {})
        .map(([agent, sig]) => ({ holder: ownerOf.get(agent), sig }))
        .filter((x) => x.holder !== undefined)
        .sort((a, b) => (BigInt(a.holder) < BigInt(b.holder) ? -1 : 1))
        .map((x) => x.sig);
      return reply({ nonce: n, to: w.to, amount: w.amount, sigs, ready: C.enough(s.valset, sigs) });
    }
    return { code: BAD, log: "unknown path" };
  }

  // ----- ABCI methods AGT does not use -----
  Echo(req) { return { message: req.message }; }
  Flush() { return {}; }
  ListSnapshots() { return { snapshots: [] }; }
  OfferSnapshot() { return { result: "REJECT" }; }
  LoadSnapshotChunk() { return { chunk: Buffer.alloc(0) }; }
  ApplySnapshotChunk() { return { result: "ABORT" }; }
  ExtendVote() { return { vote_extension: Buffer.alloc(0) }; }
  VerifyVoteExtension() { return { status: "ACCEPT" }; }
}

function serve(app, port) {
  const server = new grpc.Server();
  const impl = {};
  for (const m of Object.keys(abci.ABCI.service)) {
    impl[m] = async (call, cb) => {
      try {
        cb(null, await app[m](call.request));
      } catch (e) {
        log(`${m} failed:`, e.stack || e.message);
        cb({ code: grpc.status.INTERNAL, message: e.message });
      }
    };
  }
  server.addService(abci.ABCI.service, impl);
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) throw err;
    log(`AGT ABCI app on :${port} · AI ${app.agent ? app.agent.address : "(none)"} · BSC view: ${app.bsc.name} · height ${app.state ? app.state.height : 0}`);
  });
  return server;
}

module.exports = { btcDepositOf, AGTApp, serve, bindDigest, cmtAddress, ser, des, makeBscView };
if (require.main === module) serve(new AGTApp(), Number(process.env.PORT || 26658));
