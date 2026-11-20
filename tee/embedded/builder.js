// Independent reproduction for disputes (THIET-KE-NGHE-NHUNG.md §14, joint decision of Claude and Codex).
// Runs in a DISPOSABLE confidential VM started for one job, from the attested builder image. It holds no AI
// identity and no owner credentials; it exists for one job and is destroyed afterwards.
//   1. A fresh job key pair: X25519 (the worker's box seals the source bundle to it) + secp256k1 (signs the result).
//      Both public keys go into the builder's attested manifest, with the job nonce.
//   2. The worker's box sends the disputed commit as a git bundle sealed to the job key.
//   3. The builder opens it, checks out EXACTLY that commit, runs the brief's secret-free reproduction commands as
//      the unprivileged sandbox user (no network for the job — the VM is launched without egress), and records
//      exit codes and log hashes.
//   4. Its root supervisor signs the result with the job key, which the build cannot reach (it lives only in this
//      process's memory). Reviewers verify the attestation, the signature and the bindings — they never run code.
// Not claimed: protection against a kernel or TEE exploit by the build code (no hardware boundary around it yet).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const S = require("./secrets.js");

const SCHEMA = "agt-repro/v1";
const canonical = (v) => (Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v));
const resultDigest = (result) => ethers.keccak256(ethers.toUtf8Bytes(canonical(result)));
const contextOf = (dispute, nonce) => `repro:${dispute}:${nonce}`;

/// A new job: keys and nonce. The manifest is what the TEE attests (its hash is the attestation nonce).
function newJob({ dispute, commit, commands, imageDigest }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("bad commit");
  if (!Array.isArray(commands) || !commands.length || commands.some((c) => typeof c !== "string" || !c.trim())) throw new Error("no reproduction commands");
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const sealPub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  const signer = ethers.Wallet.createRandom();
  const nonce = crypto.randomBytes(16).toString("hex");
  const manifest = { agt: "builder-v1", dispute: Number(dispute), commit, commands, imageDigest: imageDigest || null, sealPubKey: sealPub.toString("base64"), signer: signer.address, nonce };
  return { manifest, sealPriv: privateKey, signer };
}

/// The worker's box: export exactly `commit` from its workspace as a git bundle, sealed to the builder's job key.
function exportBundle({ gitBin = "git", gitDir, commit, manifest }) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "agt-bundle-"));
  try {
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync(gitBin, ["--git-dir", gitDir, "update-ref", "refs/heads/agt-repro", commit], { env });
    const file = path.join(dir, "repro.bundle");
    execFileSync(gitBin, ["--git-dir", gitDir, "bundle", "create", file, "refs/heads/agt-repro"], { env, stdio: "ignore" });
    const b64 = fs.readFileSync(file).toString("base64");
    if (b64.length > 20 * 1024 * 1024) throw new Error("bundle too large for this version (20 MB)");
    return S.seal(manifest.sealPubKey, b64, contextOf(manifest.dispute, manifest.nonce));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/// The builder: open the bundle, check out the exact commit, run the commands unprivileged, sign the result.
async function runJob({ job, sealedBundle, tools, gitBin = "git", workRoot = "/work/repro", timeoutSec = 900, chown = true }) {
  const m = job.manifest;
  const b64 = S.open(job.sealPriv, sealedBundle, contextOf(m.dispute, m.nonce));
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o711 });
  const base = fs.mkdtempSync(path.join(workRoot, "job-"));
  const tree = path.join(base, "tree");
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always" };
  try {
    const bundle = path.join(base, "repro.bundle");
    fs.writeFileSync(bundle, Buffer.from(b64, "base64"), { mode: 0o600 });
    execFileSync(gitBin, ["clone", "-q", "--no-checkout", bundle, tree], { env });
    execFileSync(gitBin, ["-C", tree, "checkout", "-q", "--detach", m.commit], { env });
    const head = execFileSync(gitBin, ["-C", tree, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    if (head !== m.commit) throw new Error(`the bundle does not contain commit ${m.commit}`);
    const treeHash = execFileSync(gitBin, ["-C", tree, "rev-parse", "HEAD^{tree}"], { env, encoding: "utf8" }).trim();
    fs.rmSync(path.join(tree, ".git"), { recursive: true, force: true }); // the build never sees git metadata
    fs.rmSync(bundle, { force: true });
    if (chown && process.getuid && process.getuid() === 0) execFileSync("chown", ["-R", "-P", "1500:1500", tree]);
    const commands = [];
    for (const cmd of m.commands) {
      const r = await tools.run("/bin/sh", ["-c", cmd], { cwd: tree, timeoutMs: timeoutSec * 1000 });
      commands.push({ cmd, exit: r.code, timedOut: !!r.timedOut, logSha256: crypto.createHash("sha256").update(r.out || "").digest("hex") });
      if (r.code !== 0 || r.timedOut) break; // later commands depend on earlier ones
    }
    const result = { schema: SCHEMA, dispute: m.dispute, nonce: m.nonce, commit: m.commit, treeHash, imageDigest: m.imageDigest, commands, ok: commands.length === m.commands.length && commands.every((c) => c.exit === 0 && !c.timedOut) };
    const signature = await job.signer.signMessage(ethers.getBytes(resultDigest(result)));
    return { result, signature };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/// A reviewer: is this reproduction about THIS dispute and commit, with the brief's commands, from a genuine builder?
///   verifyAttestation(manifest, evidence) → true only for an approved builder image in a genuine TEE (pluggable:
///   tee/verify.js in production). Returns { valid, ok, why }.
function verifyResult({ job, result, signature, evidence, dispute, commitBytes32, commands, verifyAttestation }) {
  const fail = (why) => ({ valid: false, ok: false, why });
  if (!job || !job.manifest || !result || result.schema !== SCHEMA) return fail("not a reproduction result");
  const m = job.manifest;
  if (!verifyAttestation(m, evidence)) return fail("the builder is not an attested builder image");
  let signer;
  try { signer = ethers.verifyMessage(ethers.getBytes(resultDigest(result)), signature); } catch { return fail("bad signature"); }
  if (signer !== m.signer) return fail("not signed by this builder's job key");
  if (result.nonce !== m.nonce || result.dispute !== Number(dispute) || m.dispute !== Number(dispute)) return fail("for another job or dispute");
  if ("0x" + result.commit.padEnd(64, "0") !== commitBytes32 || m.commit !== result.commit) return fail("about another commit");
  if (canonical(m.commands) !== canonical(commands)) return fail("not the brief's reproduction commands");
  return { valid: true, ok: !!result.ok, why: result.ok ? "reproduced: every command passed" : `reproduced: ${result.commands.map((c) => `${c.cmd} → ${c.timedOut ? "timeout" : "exit " + c.exit}`).join("; ")}` };
}

module.exports = { newJob, exportBundle, runJob, verifyResult, resultDigest, contextOf, canonical, SCHEMA };
