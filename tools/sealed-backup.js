// Encrypted off-site backup of a private git repo (used for the private question bank, which is never published).
// The whole history goes into a git bundle, which is encrypted with a key derived from a passphrase that only the
// owner holds (scrypt N=2^17, AES-256-GCM). The output file is safe to store anywhere; without the passphrase it
// is noise.
//
//   AGT_BACKUP_PASSPHRASE=... node tools/sealed-backup.js backup  <repo-dir> <out.agtbak>
//   AGT_BACKUP_PASSPHRASE=... node tools/sealed-backup.js restore <in.agtbak> <new-dir>
//   AGT_BACKUP_PASSPHRASE=... node tools/sealed-backup.js verify  <in.agtbak> <repo-dir>   (restore to a temp dir, compare)
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const MAGIC = Buffer.from("AGTBAK1\0");
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function passphrase() {
  const p = process.env.AGT_BACKUP_PASSPHRASE || "";
  if (p.length < 20) throw new Error("set AGT_BACKUP_PASSPHRASE (at least 20 characters; a long phrase written on paper)");
  return p;
}
const keyOf = (pass, salt) => crypto.scryptSync(pass.normalize("NFKC"), salt, 32, SCRYPT);

function seal(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyOf(pass, salt), iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
function open(blob, pass) {
  if (!blob.subarray(0, 8).equals(MAGIC)) throw new Error("not an AGT backup");
  const salt = blob.subarray(8, 24), iv = blob.subarray(24, 36), tag = blob.subarray(36, 52);
  const d = crypto.createDecipheriv("aes-256-gcm", keyOf(pass, salt), iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(blob.subarray(52)), d.final()]); } catch { throw new Error("wrong passphrase or damaged file"); }
}

function backup(repo, out, pass = passphrase()) {
  if (git(["status", "--porcelain"], repo).trim()) throw new Error("the repo has uncommitted changes — commit first, so the backup is complete");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agtbak-"));
  try {
    const bundle = path.join(tmp, "repo.bundle");
    git(["bundle", "create", bundle, "--all"], repo);
    fs.writeFileSync(out, seal(fs.readFileSync(bundle), pass));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { head: git(["rev-parse", "HEAD"], repo).trim(), bytes: fs.statSync(out).size };
}

function restore(file, dir, pass = passphrase()) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agtbak-"));
  try {
    const bundle = path.join(tmp, "repo.bundle");
    fs.writeFileSync(bundle, open(fs.readFileSync(file), pass));
    git(["clone", "-q", bundle, dir], tmp);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { head: git(["rev-parse", "HEAD"], dir).trim() };
}

/// Restore into a temp dir and compare with the live repo: every branch and tag by name and object id, HEAD, its
/// tree and the whole history (committed state only — the working tree is never part of a backup).
function verify(file, repo, pass = passphrase()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agtbak-v-"));
  try {
    const dir = path.join(tmp, "r");
    restore(file, dir, pass);
    const same = (args) => git(args, dir) === git(args, repo);
    // refs in the restore: local branches come back as origin/<name>; tags as tags (Codex N-3)
    const refsOf = (cwd, map) => git(["for-each-ref", "--format=%(objectname) %(refname)", ...map.from], cwd).split("\n").filter(Boolean).map((l) => l.replace(map.re, map.to)).filter((l) => !/\/HEAD$/.test(l)).sort().join("\n");
    const live = refsOf(repo, { from: ["refs/heads", "refs/tags"], re: /^$/, to: "" });
    const back = refsOf(dir, { from: ["refs/remotes/origin", "refs/tags"], re: / refs\/remotes\/origin\//, to: " refs/heads/" });
    const ok = live === back && same(["rev-parse", "HEAD"]) && same(["rev-parse", "HEAD^{tree}"]) && same(["log", "--format=%H", "--all"]);
    return { ok, head: git(["rev-parse", "HEAD"], dir).trim() };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { seal, open, backup, restore, verify };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "backup") { const r = backup(a, b); console.log(`✔ backup ${b}: ${r.bytes} bytes, head ${r.head.slice(0, 10)} — now run verify, then copy the file off this machine`); }
    else if (cmd === "restore") { const r = restore(a, b); console.log(`✔ restored to ${b}, head ${r.head.slice(0, 10)}`); }
    else if (cmd === "verify") { const r = verify(a, b); console.log(r.ok ? `✔ the backup restores to exactly this repo (head ${r.head.slice(0, 10)})` : "✘ the backup does NOT match this repo"); process.exit(r.ok ? 0 : 1); }
    else { console.log("usage: backup <repo> <out> | restore <file> <dir> | verify <file> <repo>"); process.exit(2); }
  } catch (e) { console.error("✘", e.message); process.exit(1); }
}
