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
const BIND_TAG = "AGT-BIND-VALIDATOR-v1";
const lower = (a) => ethers.getAddress(a).toLowerCase();
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
  return out;
}

// ---------- the application ----------
class AGTApp {
  constructor(env = process.env) {
    this.stateFile = env.STATE_FILE || path.join(process.cwd(), "agt-state.json");
    this.agent = env.AGENT_KEY ? new ethers.Wallet(env.AGENT_KEY) : null;
    this.cmtRpc = env.CMT_RPC || "http://127.0.0.1:26657";
    this.bsc = makeBscView(env);
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
      if (Buffer.from(String(tx.pubKey), "base64").length !== 32) throw new Error("bad ed25519 key");
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
    s.cmt = cmt;
    s.binds = Object.fromEntries(Object.values(cmt).map((v) => [v.agent, v.pubKey]));
    s.licIds = Object.fromEntries(g.validators.map((v, i) => [lower(v.agent), Number(v.id ?? i + 1)]));
    s.bscBlock = Number(g.bscBlock || 0);
    s.active = activeSet(s);
    s.attest = {};
    s.pendingWage = 0n;
    this.state = s;
    this.check = structuredClone(s);
    log(`InitChain ${req.chain_id}: ${g.validators.length} AI validators, ${g.holders} owners`);
    return {
      consensus_params: null,
      validators: g.validators.map((v) => ({ pub_key: { ed25519: Buffer.from(v.pubKey, "base64") }, power: "1" })), // 1 owner = 1 vote
      app_hash: appHash(s),
    };
  }

  CheckTx(req) {
    try {
      const tx = this.decode(req.tx);
      this.applyAny(this.check, tx);
      return { code: OK };
    } catch (e) {
      return { code: BAD, log: e.message };
    }
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
    try {
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
    try {
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
        .filter(Boolean)
        .map((v) => v.holder))].sort();
      if (owners.length) {
        const share = s.pendingWage / BigInt(owners.length);
        owners.forEach((o, i) => {
          const pay = share + (i === 0 ? s.pendingWage - share * BigInt(owners.length) : 0n);
          s.balances[o] = (s.balances[o] || 0n) + pay;
          s.wages[o] = (s.wages[o] || 0n) + pay;
        });
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
    const next = activeSet(s);
    const validator_updates = [];
    if (Object.keys(next).length > 0) {
      for (const pk of Object.keys(s.active)) if (!(pk in next)) validator_updates.push({ pub_key: { ed25519: Buffer.from(pk, "base64") }, power: "0" });
      for (const pk of Object.keys(next)) if (!(pk in s.active)) validator_updates.push({ pub_key: { ed25519: Buffer.from(pk, "base64") }, power: "1" });
      s.active = next;
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
    if (p.startsWith("/balance/")) {
      const a = lower(p.slice(9));
      return reply({ address: a, balance: s.balances[a] || 0n, nonce: s.nonces[a] || 0 });
    }
    if (p.startsWith("/release/")) {
      // Ready-to-submit package for AGTBridge.release(): one signature per owner, sorted by owner address.
      const n = Number(p.slice(9));
      const w = s.outbox[n];
      if (!w) return { code: BAD, log: "no such withdrawal" };
      const ownerOf = new Map(s.valset.validators.map((v) => [v.agent, v.holder]));
      const sigs = Object.entries(s.attest[n] || {})
        .map(([agent, sig]) => ({ holder: ownerOf.get(agent), sig }))
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

module.exports = { AGTApp, serve, bindDigest, cmtAddress, ser, des, makeBscView };
if (require.main === module) serve(new AGTApp(), Number(process.env.PORT || 26658));
