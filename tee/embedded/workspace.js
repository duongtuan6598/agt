// The client's repository inside the sealed box (THIET-KE-NGHE-NHUNG.md §5). The repository is UNTRUSTED.
//
// Root (the box's own process, which holds the AI's keys) runs git; the sandbox user `builder` runs the
// client's build. They must never cross:
// - The git directory lives OUTSIDE the work tree, owned by root, mode 700 (`--separate-git-dir`). The client's
//   code cannot plant hooks, config (core.fsmonitor, core.sshCommand, filters…) or anything git as root reads.
// - Every git command runs with hooks disabled and no fsmonitor, from a clean environment; the repository token
//   is passed only in that process's ENVIRONMENT (GIT_CONFIG_*), which other users cannot read — never in argv.
// - Before root reads or writes the tree, every sandbox process is killed; root then refuses symlinks and any
//   path that resolves outside the tree, so a planted link cannot make root read or overwrite its own files.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BUILDER = { uid: Number(process.env.AGT_BUILDER_UID || 1500), gid: Number(process.env.AGT_BUILDER_GID || 1500) };
const isRoot = () => process.getuid && process.getuid() === 0;
const TEXT = /\.(c|h|cc|cpp|hpp|hh|s|S|asm|ld|lds|cmake|txt|md|mk|py|json|ya?ml|toml|ini|cfg|conf|rs|dts|dtsi|overlay|kconfig|sh)$|(^|\/)(Makefile|CMakeLists\.txt|Kconfig[^/]*|prj\.conf|west\.yml)$/i;

class Workspace {
  /// root: a directory only root can enter (e.g. /var/agt/ws); id: engagement key (e.g. "engagement-12")
  constructor({ root, id, git = "git", allowFileUrls = false }) {
    this.base = path.join(root, id);
    this.tree = path.join(this.base, "tree");
    this.gitDir = path.join(this.base, "git");
    this.gitBin = git;
    this.allowFileUrls = allowFileUrls;
  }

  _env(token) {
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: this.base, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const cfg = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["protocol.file.allow", this.allowFileUrls ? "always" : "never"], ["protocol.ext.allow", "never"], ["user.name", "AGT sealed AI"], ["user.email", "ai@agt.invalid"]];
    if (token) cfg.push(["http.extraHeader", "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64")]);
    env.GIT_CONFIG_COUNT = String(cfg.length);
    cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    return env;
  }

  _git(args, token, opts = {}) {
    return execFileSync(this.gitBin, ["--git-dir", this.gitDir, "--work-tree", this.tree, ...args], { env: this._env(token), encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...opts });
  }

  /// Clone (or refresh) the repository, then work on `branch` from the default branch's head.
  clone(url, token, branch) {
    if (!/^https:\/\//.test(url) && !(this.allowFileUrls && /^file:\/\//.test(url))) throw new Error("only https repositories are accepted");
    if (!/^agt\/[\w.-]+$/.test(branch)) throw new Error("bad branch name");
    this.killSandbox();
    fs.rmSync(this.base, { recursive: true, force: true });
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    execFileSync(this.gitBin, ["clone", "--no-checkout", "--separate-git-dir", this.gitDir, url, this.tree], { env: this._env(token), encoding: "utf8", timeout: 600000 });
    fs.rmSync(path.join(this.tree, ".git"), { force: true }); // the gitdir pointer file: root passes --git-dir explicitly
    this._git(["checkout", "-q", "-f", "-B", branch], token);
    fs.chmodSync(this.base, 0o711); // builder may reach the tree, never the git dir
    fs.chmodSync(this.gitDir, 0o700);
    this.giveToBuilder();
  }

  giveToBuilder() {
    if (isRoot()) execFileSync("chown", ["-R", `${BUILDER.uid}:${BUILDER.gid}`, this.tree]);
  }

  /// Kill every sandbox-user process: nothing of the client's code runs while root touches the tree.
  killSandbox() {
    if (!isRoot()) return;
    try { execFileSync("/bin/sh", ["-c", "kill -9 -1"], { uid: BUILDER.uid, gid: BUILDER.gid, timeout: 5000 }); } catch {}
  }

  /// Resolve a repository path safely: inside the tree, no symlink anywhere on the way. Returns null if unsafe.
  _safe(rel) {
    if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p === ".git")) return null;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let cur = this.tree;
    for (const p of parts) {
      cur = path.join(cur, p);
      let st = null;
      try { st = fs.lstatSync(cur); } catch {}
      if (st && st.isSymbolicLink()) return null;
    }
    return cur;
  }

  /// Text files for the model: no symlinks, inside the tree, bounded.
  read({ maxBytes = 300000, maxFile = 60000 } = {}) {
    this.killSandbox();
    const tree = [];
    const files = [];
    let total = 0;
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === ".git" || e.isSymbolicLink()) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) { if (!/^(build|out|\.cache|node_modules)$/.test(e.name)) walk(path.join(dir, e.name), r); continue; }
        if (!e.isFile()) continue;
        tree.push(r);
        if (!TEXT.test(r)) continue;
        const f = this._safe(r);
        if (!f) continue;
        const size = fs.statSync(f).size;
        if (size > maxFile || total + size > maxBytes) continue;
        files.push({ path: r, content: fs.readFileSync(f, "utf8") });
        total += size;
      }
    };
    walk(this.tree, "");
    return { tree: tree.slice(0, 2000), files };
  }

  /// Apply the model's files. Refuses unsafe paths and pinned files (path → sha256 from the brief).
  write(files, pinned = {}) {
    this.killSandbox();
    const done = [];
    for (const f of files) {
      if (!f || typeof f.content !== "string" || f.content.length > 1000000) throw new Error("bad file from the model");
      if (Object.prototype.hasOwnProperty.call(pinned, f.path)) throw new Error(`${f.path} is pinned by the client and may not change`);
      const target = this._safe(f.path);
      if (!target) throw new Error(`unsafe path ${f.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true }); // _safe checked every existing component; new ones are root's
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o644);
      fs.writeSync(fd, f.content);
      fs.closeSync(fd);
      done.push(f.path);
    }
    this.giveToBuilder();
    return done;
  }

  /// Commit everything in the tree on the branch; returns the commit sha (40 hex).
  commit(message) {
    this.killSandbox();
    this._git(["add", "-A"]);
    try { this._git(["commit", "-q", "--no-verify", "-m", message]); } catch (e) { if (!/nothing to commit/.test(String(e.stdout || e.message))) throw e; }
    return this._git(["rev-parse", "HEAD"]).trim();
  }

  push(branch, token) {
    this._git(["push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`], token);
  }

  log(n = 10) {
    return this._git(["log", `-${n}`, "--format=%h %ad %s", "--date=short"]);
  }
}

/// A 40-hex git sha as bytes32 (left-aligned), for Engagement.deliver / deliverFix / Maintenance.resolve.
const shaToBytes32 = (sha) => "0x" + sha.toLowerCase().padEnd(64, "0");
const hashText = (t) => "0x" + crypto.createHash("sha256").update(t).digest("hex");

module.exports = { Workspace, shaToBytes32, hashText, TEXT };
