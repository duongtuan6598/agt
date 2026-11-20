// The AI's per-engagement memory, stored as CIPHERTEXT in the client's own repository (THIET-KE-NGHE-NHUNG.md §16,
// joint decision of Claude and Codex): branch `agt/memory`, one file per entry, never rewritten. The client owns
// and pays for the storage, it survives the AGT services and any replaced VM, and nobody else keeps a copy.
// Only root touches it, through a bare git dir of its own: nothing is ever checked out, nothing of the client runs.
//
// Store interface (for EngagementMemory): list(prefix) → names, get(name) → text|null, put(name, text).
// put is CREATE-ONLY and compare-and-swap: it builds on the branch head it just read and pushes without force, so
// if another box appended meanwhile the push is rejected and nothing is overwritten (Codex: one writer per head).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Workspace, checkRepoUrl } = require("./workspace.js");

const BRANCH = "agt/memory";
// Bounds (Codex M-2): the branch is written only by AI boxes, so anything bigger or stranger is tampering.
const MAX_ENTRIES = 50000;
const MAX_ENTRY_BYTES = 64 * 1024;
const FILE_RE = /^mem_[0-9a-f]{32}_[0-9]{8}$/;
const REF = "refs/agt/memory";
const fileOf = (name) => name.replace(/:/g, "_"); // file names portable everywhere (no ':' on Windows)
const nameOf = (file) => file.replace(/^mem_([0-9a-f]{32})_/, "mem:$1:");

class MemoryConflict extends Error {}

class RepoMemoryStore {
  /// dir: a root-only directory for this engagement's bare git dir; url/token: the client's repository and access.
  constructor({ dir, url, token, git = "git", allowFileUrls = false }) {
    this.gitDir = dir;
    this.token = token;
    this.ws = new Workspace({ root: path.dirname(dir), id: path.basename(dir), git, allowFileUrls }); // its hardened git env
    this.ws.url = checkRepoUrl(url, allowFileUrls);
    this.gitBin = git;
    this.fetched = false;
  }

  _git(args, opts = {}) {
    return execFileSync(this.gitBin, ["--git-dir", this.gitDir, ...args], { env: this.ws._env(this.token), encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...opts });
  }

  _init() {
    if (fs.existsSync(path.join(this.gitDir, "HEAD"))) return;
    fs.mkdirSync(this.gitDir, { recursive: true, mode: 0o700 });
    this._git(["init", "-q", "--bare"]);
  }

  /// Read the branch from the client's repository (it may not exist yet: an empty memory).
  _fetch() {
    this._init();
    try {
      // only the newest commit (its tree is the whole memory), no big blobs, and a hard time limit
      this._git(["fetch", "-q", "--no-tags", "--depth=1", `--filter=blob:limit=${MAX_ENTRY_BYTES}`, this.ws.url, `+refs/heads/${BRANCH}:${REF}`]);
    } catch (e) {
      if (!/couldn't find remote ref|could not find remote ref/i.test(String(e.stderr || e.message))) throw e;
      try { this._git(["update-ref", "-d", REF]); } catch {}
    }
    this.fetched = true;
  }

  _head() {
    try { return this._git(["rev-parse", "--verify", "-q", `${REF}^{commit}`]).trim(); } catch { return null; }
  }

  _files(head) {
    if (!head) return [];
    const out = this._git(["ls-tree", "--full-tree", "-z", "-l", head]).split("\0").filter(Boolean).map((l) => {
      const [meta, file] = l.split("\t");
      const [mode, type, sha, size] = meta.trim().split(/\s+/);
      return { mode, type, sha, size: Number(size), file };
    });
    if (out.length > MAX_ENTRIES) throw new Error(`memory branch has ${out.length} entries — more than any box writes`);
    for (const f of out) {
      if (f.mode !== "100644" || f.type !== "blob" || !FILE_RE.test(f.file) || !(f.size > 0 && f.size <= MAX_ENTRY_BYTES)) {
        throw new Error(`memory branch has unexpected content (${f.mode} ${f.type} ${f.file.slice(0, 60)}) — not written by an AGT box`);
      }
    }
    return out;
  }

  async list(prefix) {
    this._fetch();
    return this._files(this._head()).filter((f) => f.type === "blob").map((f) => nameOf(f.file)).filter((n) => n.startsWith(prefix));
  }

  async get(name) {
    if (!this.fetched) this._fetch();
    const head = this._head();
    if (!head) return null;
    try { return this._git(["cat-file", "blob", `${head}:${fileOf(name)}`]); } catch { return null; }
  }

  async put(name, text) {
    this._fetch(); // build on the head as it is now
    const head = this._head();
    const files = this._files(head);
    const file = fileOf(name);
    if (files.some((f) => f.file === file)) throw new MemoryConflict(`memory entry ${name} already exists — another box wrote first`);
    const blob = this._git(["hash-object", "-w", "--stdin"], { input: text }).trim();
    const lines = [...files.map((f) => `${f.mode} ${f.type} ${f.sha}\t${f.file}`), `100644 blob ${blob}\t${file}`];
    const tree = this._git(["mktree", "-z"], { input: lines.join("\0") + "\0" }).trim();
    const commit = this._git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `AGT memory entry (ciphertext) ${file.slice(-8)}`], { env: { ...this.ws._env(this.token), GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z", GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z" } }).trim();
    try {
      // No force: if the branch moved since our fetch (another box), the push is refused — compare-and-swap.
      this._git(["push", "-q", this.ws.url, `${commit}:refs/heads/${BRANCH}`]);
    } catch (e) {
      throw new MemoryConflict(`memory branch moved while writing (${String(e.stderr || e.message).split("\n")[0]}) — read again and retry`);
    }
    this._git(["update-ref", REF, commit]);
  }
}

module.exports = { RepoMemoryStore, MemoryConflict, BRANCH };
