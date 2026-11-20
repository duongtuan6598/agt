// Independent reproduction for disputes (THIET-KE-NGHE-NHUNG.md §14, joint decision of Claude and Codex).
// Runs in a DISPOSABLE confidential VM started for one job, from the attested builder image. It holds no AI
// identity and no owner credentials; it exists for one job and is destroyed afterwards.
//   1. A fresh job key pair: X25519 (the worker's box seals the source to it) + secp256k1 (signs the result).
//      Both public keys go into the builder's attested manifest, with the job nonce, commit and commands.
//   2. The worker's box sends a SNAPSHOT of exactly the disputed commit's tree (one parentless commit — no history,
//      Codex R-1) plus the original commit object, sealed to the job key.
//   3. The supervisor (root) hashes the original commit object itself: it must be the disputed commit, and the
//      snapshot's tree must be that commit's tree. All git work on the untrusted bundle runs as the sandbox user,
//      never as root (R-2). The brief's secret-free commands then run as the sandbox user (no network for the job:
//      the VM is launched without egress), within per-command and total time limits (R-6).
//   4. The supervisor signs the result with the job key, which the build cannot reach (only in this process's
//      memory). Reviewers verify the attestation, the signature and every binding (R-3) — they never run code.
// Not claimed: protection against a kernel or TEE exploit by the build code (no hardware boundary around it yet).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const S = require("./secrets.js");

const SCHEMA = "agt-repro/v1";
const MAX_COMMANDS = 10;
const MAX_COMMAND_LEN = 300;
const MAX_TOTAL_SEC = 3600;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const canonical = (v) => (Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v));
const resultDigest = (result) => ethers.keccak256(ethers.toUtf8Bytes(canonical(result)));
const contextOf = (dispute, nonce) => `repro:${dispute}:${nonce}`;
const gitObjectSha = (type, bytes) => crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])).digest("hex");

function checkCommands(commands) {
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_COMMANDS) throw new Error(`1–${MAX_COMMANDS} reproduction commands`);
  for (const c of commands) if (typeof c !== "string" || !c.trim() || c.length > MAX_COMMAND_LEN) throw new Error("bad reproduction command");
}

/// A new job: keys and nonce. The manifest is what the TEE attests (its canonical hash is the attestation nonce).
function newJob({ dispute, commit, commands, imageDigest }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("bad commit");
  checkCommands(commands);
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const sealPub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  const signer = ethers.Wallet.createRandom();
  const nonce = crypto.randomBytes(16).toString("hex");
  const manifest = { agt: "builder-v1", dispute: Number(dispute), commit, commands, imageDigest: imageDigest || null, sealPubKey: sealPub.toString("base64"), signer: signer.address, nonce };
  return { manifest, sealPriv: privateKey, signer };
}

/// The worker's box: a parentless snapshot commit of exactly `commit`'s tree (no history) + the original commit
/// object, sealed to the builder's job key.
function exportBundle({ gitBin = "git", gitDir, commit, manifest }) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "agt-bundle-"));
  try {
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "agt", GIT_AUTHOR_EMAIL: "agt@invalid", GIT_COMMITTER_NAME: "agt", GIT_COMMITTER_EMAIL: "agt@invalid", GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z", GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z" };
    const g = (args, opts = {}) => execFileSync(gitBin, ["--git-dir", gitDir, ...args], { env, ...opts });
    const commitObject = g(["cat-file", "commit", commit]);
    if (gitObjectSha("commit", commitObject) !== commit) throw new Error("commit object does not hash to the commit");
    const tree = /^tree ([0-9a-f]{40})$/m.exec(commitObject.toString("utf8"))[1];
    const snap = g(["commit-tree", tree, "-m", `AGT reproduction snapshot of ${commit}`], { encoding: "utf8" }).trim();
    g(["update-ref", "refs/heads/agt-repro", snap]);
    const file = path.join(dir, "repro.bundle");
    g(["bundle", "create", file, "refs/heads/agt-repro"], { stdio: "ignore" });
    g(["update-ref", "-d", "refs/heads/agt-repro"]);
    const size = fs.statSync(file).size;
    if (size > MAX_SOURCE_BYTES) throw new Error(`the disputed tree is too large for this version (${MAX_SOURCE_BYTES} bytes)`);
    const payload = JSON.stringify({ commitObject: commitObject.toString("base64"), bundle: fs.readFileSync(file).toString("base64") });
    return S.seal(manifest.sealPubKey, payload, contextOf(manifest.dispute, manifest.nonce));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/// The builder: verify the source binding, unpack and run as the sandbox user, sign the result.
async function runJob({ job, sealedBundle, tools, gitBin = "git", workRoot = "/work/repro", timeoutSec = 900, totalSec = MAX_TOTAL_SEC, chown = true }) {
  const m = job.manifest;
  checkCommands(m.commands);
  const payload = JSON.parse(S.open(job.sealPriv, sealedBundle, contextOf(m.dispute, m.nonce)));
  const commitObject = Buffer.from(payload.commitObject, "base64");
  if (gitObjectSha("commit", commitObject) !== m.commit) throw new Error("the source is not the disputed commit"); // checked by root, no git
  const expectedTree = /^tree ([0-9a-f]{40})$/m.exec(commitObject.toString("utf8"))[1];
  const bundleBytes = Buffer.from(payload.bundle, "base64");
  if (bundleBytes.length > MAX_SOURCE_BYTES) throw new Error("source too large");
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o711 });
  const base = fs.mkdtempSync(path.join(workRoot, "job-"));
  const asRoot = chown && process.getuid && process.getuid() === 0;
  try {
    fs.chmodSync(base, 0o711);
    const bundle = path.join(base, "repro.bundle");
    fs.writeFileSync(bundle, bundleBytes, { mode: 0o644 });
    if (asRoot) execFileSync("chown", ["1500:1500", base, bundle]);
    // All git work on the untrusted bundle runs as the sandbox user (R-2), with hooks off.
    const git = async (args) => {
      const r = await tools.run(gitBin, ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], { cwd: base, timeoutMs: 120000 });
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${String(r.out).slice(-300)}`);
      return String(r.out).trim();
    };
    await git(["clone", "-q", "--no-checkout", "repro.bundle", "tree"]);
    await git(["-C", "tree", "checkout", "-q", "--detach", "refs/remotes/origin/agt-repro"]);
    const treeHash = (await git(["-C", "tree", "rev-parse", "HEAD^{tree}"])).split("\n").pop();
    if (treeHash !== expectedTree) throw new Error("the snapshot's tree is not the disputed commit's tree");
    const tree = path.join(base, "tree");
    await tools.run("/bin/rm", ["-rf", path.join(tree, ".git"), bundle], { cwd: base }); // the build sees no git metadata
    const commands = [];
    const started = Date.now();
    for (const cmd of m.commands) {
      const left = totalSec * 1000 - (Date.now() - started);
      if (left <= 0) { commands.push({ cmd, exit: null, timedOut: true, logSha256: null }); break; }
      const r = await tools.run("/bin/sh", ["-c", cmd], { cwd: tree, timeoutMs: Math.min(timeoutSec * 1000, left) });
      commands.push({ cmd, exit: r.code, timedOut: !!r.timedOut, logSha256: crypto.createHash("sha256").update(r.out || "").digest("hex") });
      if (r.code !== 0 || r.timedOut) break; // later commands depend on earlier ones
    }
    const ok = commands.length === m.commands.length && commands.every((c) => c.exit === 0 && !c.timedOut);
    const result = { schema: SCHEMA, dispute: m.dispute, nonce: m.nonce, commit: m.commit, treeHash, imageDigest: m.imageDigest, commands, ok };
    const signature = await job.signer.signMessage(ethers.getBytes(resultDigest(result)));
    return { result, signature };
  } finally {
    if (asRoot) await tools.run("/bin/sh", ["-c", "kill -9 -1"], { cwd: "/", timeoutMs: 5000 }).catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/// A reviewer: is this reproduction about THIS dispute and commit, with the brief's commands, from a genuine builder?
///   verifyAttestation(manifest, evidence) must authenticate the CANONICAL FULL manifest (keys, nonce, commit,
///   commands, image) and accept only approved builder images in a genuine TEE (tee/verify.js in production).
/// Returns { valid, ok, why }.
function verifyResult({ job, result, signature, evidence, dispute, commitBytes32, commands, verifyAttestation }) {
  const fail = (why) => ({ valid: false, ok: false, why });
  if (!job || !job.manifest || !result || result.schema !== SCHEMA) return fail("not a reproduction result");
  const m = job.manifest;
  if (!verifyAttestation(m, evidence)) return fail("the builder is not an attested builder image");
  let signer;
  try { signer = ethers.verifyMessage(ethers.getBytes(resultDigest(result)), signature); } catch { return fail("bad signature"); }
  if (signer !== m.signer) return fail("not signed by this builder's job key");
  if (result.nonce !== m.nonce || result.dispute !== Number(dispute) || m.dispute !== Number(dispute)) return fail("for another job or dispute");
  if (typeof result.commit !== "string" || "0x" + result.commit.padEnd(64, "0") !== commitBytes32 || m.commit !== result.commit) return fail("about another commit");
  if (!/^[0-9a-f]{40}$/.test(result.treeHash || "")) return fail("no tree hash");
  if (result.imageDigest !== m.imageDigest) return fail("image differs from the attested manifest");
  if (canonical(m.commands) !== canonical(commands)) return fail("not the brief's reproduction commands");
  // the recorded commands must be a prefix of the manifest's, and `ok` must follow from them (R-3)
  const rc = Array.isArray(result.commands) ? result.commands : [];
  if (!rc.length || rc.length > m.commands.length || rc.some((c, i) => !c || c.cmd !== m.commands[i] || (c.exit !== null && !Number.isInteger(c.exit)) || typeof c.timedOut !== "boolean")) return fail("inconsistent command records");
  const okFromRecords = rc.length === m.commands.length && rc.every((c) => c.exit === 0 && !c.timedOut);
  if (result.ok !== okFromRecords) return fail("'ok' does not follow from the command records");
  return { valid: true, ok: okFromRecords, why: okFromRecords ? "reproduced: every command passed" : `reproduced: ${rc.map((c) => `${c.cmd} → ${c.timedOut ? "timeout" : "exit " + c.exit}`).join("; ")}` };
}

module.exports = { newJob, exportBundle, runJob, verifyResult, resultDigest, contextOf, canonical, gitObjectSha, SCHEMA, MAX_COMMANDS };
