// The client's repository inside the sealed box (THIET-KE-NGHE-NHUNG.md §5). The repository is UNTRUSTED.
//
// Root (the box's own process, which holds the AI's keys) runs git; the sandbox user `builder` runs the
// client's build. They must never cross (reviewed with Codex, W-1…W-9):
// - The git directory lives OUTSIDE the work tree, owned by root, mode 700 (`--separate-git-dir`). The client's
//   code cannot plant hooks or config that git as root would read; hooks and fsmonitor are disabled anyway.
// - The repository token is passed only in git's ENVIRONMENT (GIT_CONFIG_*), never in argv; it is scoped to the
//   exact repository URL (http.<url>.extraHeader), redirects are refused, and only allow-listed git hosts are
//   accepted, so the token cannot be sent to another server (W-1).
// - Before root reads or writes the tree, every sandbox process is killed. Root refuses symlinks, files with more
//   than one link (hard links, W-2) and anything that is not a regular file; it writes by creating a NEW file and
//   renaming it into place (never opening an existing entry, so no FIFO or linked inode — W-2, W-6).
// - Root commits ONLY the files the model wrote, and only if they still hold exactly what root wrote (a process
//   that survived the checks cannot slip changes into the delivery — W-3).
// - The tree is deleted after each piece of work (one job at a time; no client can read another's code — W-4).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BUILDER = { uid: Number(process.env.AGT_BUILDER_UID || 1500), gid: Number(process.env.AGT_BUILDER_GID || 1500) };
const isRoot = () => process.getuid && process.getuid() === 0;
const TEXT = /\.(c|h|cc|cpp|hpp|hh|s|S|asm|ld|lds|cmake|txt|md|mk|py|json|ya?ml|toml|ini|cfg|conf|rs|dts|dtsi|overlay|kconfig|sh)$|(^|\/)(Makefile|CMakeLists\.txt|Kconfig[^/]*|prj\.conf|west\.yml)$/i;
const GIT_HOSTS = (process.env.AGT_GIT_HOSTS || "github.com,gitlab.com,bitbucket.org,codeberg.org").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/// Accept only https://<allow-listed host>/<path> (no user info, no port tricks), or file:// in tests.
function checkRepoUrl(url, allowFileUrls) {
  if (allowFileUrls && /^file:\/\//.test(url)) return url;
  let u;
  try { u = new URL(url); } catch { throw new Error("bad repository URL"); }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || u.search || u.hash) throw new Error("only plain https repository URLs are accepted");
  if (!GIT_HOSTS.includes(u.hostname.toLowerCase())) throw new Error(`repository host ${u.hostname} is not an accepted git host (${GIT_HOSTS.join(", ")})`);
  if (!/^\/[\w.~-]+(\/[\w.~-]+)+$/.test(u.pathname)) throw new Error("bad repository path");
  return `https://${u.hostname.toLowerCase()}${u.pathname}`;
}

class Workspace {
  /// root: a directory only root can enter (e.g. /var/agt/ws); id: engagement key (e.g. "engagement-12")
  constructor({ root, id, git = "git", allowFileUrls = false }) {
    this.base = path.join(root, id);
    this.tree = path.join(this.base, "tree");
    this.gitDir = path.join(this.base, "git");
    this.gitBin = git;
    this.allowFileUrls = allowFileUrls;
    this.written = new Map(); // path → sha256 of what root wrote
  }

  _env(token) {
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: this.base, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const cfg = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.symlinks", "true"], ["protocol.file.allow", this.allowFileUrls ? "always" : "never"], ["protocol.ext.allow", "never"], ["http.followRedirects", "false"], ["submodule.recurse", "false"], ["user.name", "AGT sealed AI"], ["user.email", "ai@agt.invalid"]];
    if (token && this.url) cfg.push([`http.${this.url}.extraHeader`, "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64")]);
    env.GIT_CONFIG_COUNT = String(cfg.length);
    cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    return env;
  }

  _git(args, token, opts = {}) {
    return execFileSync(this.gitBin, ["--git-dir", this.gitDir, "--work-tree", this.tree, ...args], { env: this._env(token), encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...opts });
  }

  /// Clone the repository, then work on `branch` from the default branch's head.
  clone(url, token, branch) {
    this.url = checkRepoUrl(url, this.allowFileUrls);
    if (!/^agt\/[\w.-]+$/.test(branch)) throw new Error("bad branch name");
    this.killSandbox();
    fs.rmSync(this.base, { recursive: true, force: true });
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    execFileSync(this.gitBin, ["clone", "--no-checkout", "--no-recurse-submodules", "--separate-git-dir", this.gitDir, this.url, this.tree], { env: this._env(token), encoding: "utf8", timeout: 600000 });
    fs.rmSync(path.join(this.tree, ".git"), { force: true }); // the gitdir pointer file: root passes --git-dir explicitly
    this._git(["checkout", "-q", "-f", "-B", branch], token);
    fs.chmodSync(this.base, 0o711); // builder may reach the tree, never the git dir
    fs.chmodSync(this.gitDir, 0o700);
    // Hand the fresh checkout to the builder ONCE, before any client code has run (no planted links can exist yet).
    if (isRoot()) execFileSync("chown", ["-R", "-P", `${BUILDER.uid}:${BUILDER.gid}`, this.tree]);
  }

  /// Kill every sandbox-user process: nothing of the client's code runs while root touches the tree.
  killSandbox() {
    if (!isRoot()) return;
    for (let i = 0; i < 3; i++) { try { execFileSync("/bin/sh", ["-c", "kill -9 -1"], { uid: BUILDER.uid, gid: BUILDER.gid, timeout: 5000 }); } catch {} }
  }

  /// Resolve a repository path safely: inside the tree, no symlink on the way. Returns null if unsafe.
  _safe(rel) {
    if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p === "." || p.toLowerCase() === ".git")) return null;
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

  /// Text files for the model: regular files only, one link only, inside the tree, bounded.
  read({ maxBytes = 300000, maxFile = 60000 } = {}) {
    this.killSandbox();
    const tree = [];
    const files = [];
    let total = 0;
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.toLowerCase() === ".git" || e.isSymbolicLink()) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) { if (!/^(build|out|\.cache|node_modules)$/.test(e.name)) walk(path.join(dir, e.name), r); continue; }
        if (!e.isFile()) continue;
        tree.push(r);
        if (!TEXT.test(r)) continue;
        const f = this._safe(r);
        if (!f) continue;
        const st = fs.lstatSync(f);
        if (!st.isFile() || st.nlink !== 1 || st.size > maxFile || total + st.size > maxBytes) continue;
        const fd = fs.openSync(f, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        try {
          const s2 = fs.fstatSync(fd);
          if (!s2.isFile() || s2.nlink !== 1 || s2.ino !== st.ino) continue;
          files.push({ path: r, content: fs.readFileSync(fd, "utf8") });
          total += s2.size;
        } finally { fs.closeSync(fd); }
      }
    };
    walk(this.tree, "");
    return { tree: tree.slice(0, 2000), files };
  }

  /// Apply the model's files: a NEW file written by root, then renamed over the entry. Pinned files refused.
  write(files, pinned = {}) {
    this.killSandbox();
    const done = [];
    for (const f of files) {
      if (!f || typeof f.content !== "string" || f.content.length > 1000000) throw new Error("bad file from the model");
      if (Object.prototype.hasOwnProperty.call(pinned, f.path)) throw new Error(`${f.path} is pinned by the client and may not change`);
      const target = this._safe(f.path);
      if (!target) throw new Error(`unsafe path ${f.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.realpathSync(path.dirname(target)) !== path.dirname(target) && !fs.realpathSync(path.dirname(target)).startsWith(fs.realpathSync(this.tree) + path.sep)) throw new Error(`unsafe directory for ${f.path}`);
      let st = null;
      try { st = fs.lstatSync(target); } catch {}
      if (st && !st.isFile()) throw new Error(`${f.path} exists and is not a regular file`);
      const tmp = path.join(path.dirname(target), `.agt-${crypto.randomBytes(8).toString("hex")}`);
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
      try { fs.writeSync(fd, f.content); } finally { fs.closeSync(fd); }
      if (isRoot()) fs.chownSync(tmp, BUILDER.uid, BUILDER.gid);
      fs.renameSync(tmp, target); // replaces the directory entry; never writes into an existing inode
      this.written.set(f.path, sha(f.content));
      done.push(f.path);
    }
    return done;
  }

  /// Commit ONLY the files root wrote, and only if each still holds exactly what root wrote. Returns the sha.
  commit(message) {
    this.killSandbox();
    const paths = [...this.written.keys()];
    if (!paths.length) throw new Error("nothing to commit");
    for (const p of paths) {
      const f = this._safe(p);
      const st = f && fs.lstatSync(f);
      if (!st || !st.isFile() || st.nlink !== 1 || sha(fs.readFileSync(f)) !== this.written.get(p)) throw new Error(`${p} changed after the checks — refusing to deliver`);
    }
    this._git(["add", "--", ...paths]);
    try { this._git(["commit", "-q", "--no-verify", "-m", message, "--", ...paths]); } catch (e) { if (!/nothing to commit|no changes added/.test(String(e.stdout || e.message))) throw e; }
    return this._git(["rev-parse", "HEAD"]).trim();
  }

  push(branch, token) {
    this._git(["push", "-q", "--force", this.url, `HEAD:refs/heads/${branch}`], token);
  }

  log(n = 10) {
    return this._git(["log", `-${n}`, "--format=%h %ad %s", "--date=short"]);
  }

  /// Remove everything of this job (the next client's build must not find this one's code).
  dispose() {
    this.killSandbox();
    fs.rmSync(this.base, { recursive: true, force: true });
  }
}

/// A 40-hex git sha as bytes32 (left-aligned), for Engagement.deliver / deliverFix / Maintenance.resolve.
const shaToBytes32 = (s) => "0x" + s.toLowerCase().padEnd(64, "0");
const hashText = (t) => "0x" + sha(t);

module.exports = { Workspace, shaToBytes32, hashText, checkRepoUrl, TEXT, GIT_HOSTS };
