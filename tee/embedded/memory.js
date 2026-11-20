// Per-engagement memory of the sealed AI (THIET-KE-NGHE-NHUNG.md §5): decisions, architecture notes, bugs,
// test history — what lets the same AI keep a client's project for years.
// - Encrypted in the box with a key derived from the escrowed master (k.memory) and the engagement context,
//   so it survives restarts (the master comes back by escrow) and nobody outside the box can read it.
// - Stored anywhere (public content store, disk, a bucket): the storage only ever sees ciphertext.
// - Each entry is chained to the previous one (prev hash), so entries cannot be dropped or reordered unseen.
// - At the end of an engagement the client receives a plaintext export, then the memory key is forgotten.
const crypto = require("crypto");

function keyFor(memoryMaster, context) {
  return Buffer.from(crypto.hkdfSync("sha256", memoryMaster, Buffer.from(context), "agt-memory-v1", 32));
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

class EngagementMemory {
  // store: { put(name, string), get(name) → string|null, list(prefix) → [names] }
  constructor(memoryMaster, context, store) {
    this.key = keyFor(memoryMaster, context);
    this.context = context;
    this.store = store;
    // storage names are keyed: they cannot be linked to an engagement without the box's key (Codex S-9)
    this.prefix = "mem:" + crypto.createHmac("sha256", this.key).update("name").digest("hex").slice(0, 32) + ":";
    this.lock = Promise.resolve();
  }

  _enc(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(this.context));
    const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
    return JSON.stringify({ iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") });
  }

  _dec(text) {
    const b = JSON.parse(text);
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(b.iv, "base64"));
    d.setAAD(Buffer.from(this.context));
    d.setAuthTag(Buffer.from(b.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(b.ct, "base64")), d.final()]).toString());
  }

  /// `anchor`: a head hash recorded somewhere trusted (the on-chain delivery report). The stored chain must
  /// contain it, so storage cannot roll the memory back to an older prefix unseen (Codex S-7).
  async entries({ anchor = null } = {}) {
    const names = (await this.store.list(this.prefix)).sort();
    const out = [];
    let prev = "genesis";
    for (const n of names) {
      const e = this._dec(await this.store.get(n));
      if (e.prev !== prev) throw new Error(`memory chain broken at ${n}`);
      prev = sha(JSON.stringify(e));
      out.push(e);
      if (anchor && prev === anchor) anchor = null;
    }
    if (anchor && anchor !== "genesis") throw new Error("memory rolled back: the anchored head is missing");
    return out;
  }

  /// The hash of the latest entry ("genesis" when empty): put it in each delivery report to anchor the memory.
  async head() {
    const all = await this.entries();
    return all.length ? sha(JSON.stringify(all[all.length - 1])) : "genesis";
  }

  /// kind: "decision" | "note" | "bug" | "test" | "delivery" …; text: what to remember.
  async append(kind, text, at = Math.floor(Date.now() / 1000)) {
    const run = this.lock.then(() => this._append(kind, text, at)); // one writer at a time
    this.lock = run.catch(() => {});
    return run;
  }

  async _append(kind, text, at) {
    const all = await this.entries();
    const prev = all.length ? sha(JSON.stringify(all[all.length - 1])) : "genesis";
    const e = { n: all.length, kind, text: String(text), at, prev };
    await this.store.put(this.prefix + String(all.length).padStart(8, "0"), this._enc(e));
    return e;
  }

  /// What the model reads before working on this client's project (newest last, bounded).
  async context_(maxChars = 20000) {
    const lines = (await this.entries()).map((e) => `[${new Date(e.at * 1000).toISOString().slice(0, 10)}] ${e.kind}: ${e.text}`);
    let s = "";
    for (let i = lines.length - 1; i >= 0 && s.length + lines[i].length < maxChars; i--) s = lines[i] + "\n" + s;
    return s;
  }

  /// End of the engagement: the client gets everything in plain text.
  async export() {
    return { context: this.context, entries: await this.entries() };
  }
}

function memoryStore() {
  const m = new Map();
  return { put: async (k, v) => void m.set(k, v), get: async (k) => m.get(k) ?? null, list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)), raw: m };
}

module.exports = { EngagementMemory, memoryStore, keyFor };
