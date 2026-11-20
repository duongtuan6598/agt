// §14–§15: the production builder check (verify-builder.js) and the builder's supervisor flow (main.js), without a
// cloud: we play Google's attestation service with our own RSA key, the job bucket is a Map, git is real.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const T = require("../verify.js");
const R = require("../embedded/builder.js");
const { makeVerifyBuilder } = require("../builder/verify-builder.js");
const { runBuilder } = require("../builder/main.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = [{ ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" }];
const BUILDER = "sha256:" + "bb".repeat(32);
const BOX = "sha256:" + "aa".repeat(32);
const now = Math.floor(Date.now() / 1000);
const sign = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "test-kid", typ: "JWT" }) + "." + enc(claims);
  return head + "." + crypto.sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url");
};
const claims = (nonce, over = {}) => ({
  iss: T.ISSUER, aud: T.AUDIENCE, iat: now, nbf: now, exp: now + 3600, swname: "CONFIDENTIAL_SPACE", hwmodel: "GCP_AMD_SEV", dbgstat: "disabled-since-boot", secboot: true,
  submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: BUILDER, restart_policy: "Never" } }, eat_nonce: nonce, ...over,
});
const policy = { audience: T.AUDIENCE, hwmodels: ["GCP_INTEL_TDX", "GCP_AMD_SEV"], imageDigests: [BOX], builderImages: [BUILDER], charterHash: T.charterHash() };
const verify = makeVerifyBuilder({ jwks, policy });
const job = () => R.newJob({ dispute: 4, commit: "c".repeat(40), commands: ["make"], imageDigest: BUILDER });

test("a builder is trusted only with an attested BUILDER image and the exact manifest", () => {
  const j = job();
  const ok = { token: sign(claims(T.nonceOf(j.manifest))) };
  assert.equal(verify(j.manifest, ok), true);
  assert.equal(verify(j.manifest, { token: sign(claims(T.nonceOf(j.manifest), { submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: BOX, restart_policy: "Never" } } })) }), false, "an AI box image is not a builder");
  assert.equal(verify({ ...j.manifest, commands: ["make", "true"] }, ok), false, "any change to the manifest breaks the binding");
  assert.equal(verify({ ...j.manifest, signer: ethers.Wallet.createRandom().address }, ok), false, "a swapped job key breaks the binding");
  assert.equal(verify(j.manifest, { token: sign(claims(T.nonceOf(j.manifest), { dbgstat: "enabled" })) }), false, "debug");
  assert.equal(verify({ ...job().manifest, imageDigest: "sha256:" + "cc".repeat(32) }, { token: sign(claims(T.nonceOf({ ...job().manifest }))) }), false);
  assert.equal(makeVerifyBuilder({ jwks, policy: { ...policy, builderImages: [] } })(j.manifest, ok), false, "nothing approved → nothing trusted");
});

test("the supervisor: spec → attested job → sealed source → signed result a reviewer accepts", async () => {
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "c", GIT_AUTHOR_EMAIL: "c@c", GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@c" } });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "agt-fw-"));
  fs.writeFileSync(path.join(src, "main.c"), "int main(void){return 0;}\n");
  git(["init", "-q"], src);
  git(["add", "-A"], src);
  git(["commit", "-q", "-m", "m1"], src);
  fs.writeFileSync(path.join(src, "later.c"), "/* a later commit: must not travel */\n");
  git(["add", "-A"], src);
  git(["commit", "-q", "-m", "m2"], src);
  const commit = git(["rev-parse", "HEAD~1"], src).trim();
  const GIT = process.platform === "win32" ? execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() : "git";

  const bucket = new Map([["spec.json", JSON.stringify({ dispute: 4, commit, commands: ["make"], imageDigest: BUILDER })]]);
  const io = { get: async (k) => bucket.get(k) ?? null, put: async (k, v) => void bucket.set(k, v) };
  const tools = { run: async (cmd, args, opts = {}) => {
    if (cmd === "git" || cmd === GIT) { try { return { code: 0, out: execFileSync(GIT, args, { cwd: opts.cwd, encoding: "utf8" }) }; } catch (e) { return { code: 1, out: e.message }; } }
    if (cmd === "/bin/rm") { for (const f of args.slice(1)) fs.rmSync(f, { recursive: true, force: true }); return { code: 0, out: "" }; }
    return { code: 0, out: "built", timedOut: false };
  } };
  // The party's relay: when job.json appears, the worker's box (here: inline) seals the source to the job key.
  let polls = 0;
  const sleep = async () => {
    polls++;
    const j = JSON.parse(bucket.get("job.json"));
    assert.equal(ethers.verifyMessage(`AGT repro job ${ethers.keccak256(ethers.toUtf8Bytes(R.canonical(j.manifest)))}`, j.signature), j.manifest.signer);
    assert.equal(verify(j.manifest, j.evidence), true, "the worker's box checks the builder before sending anything");
    bucket.set("source.sealed", JSON.stringify(R.exportBundle({ gitBin: GIT, gitDir: path.join(src, ".git"), commit, manifest: j.manifest })));
  };
  const attest = async (nonce) => ({ token: sign(claims(nonce)) });
  const out = await runBuilder({ io, attest, tools: { ...tools, run: (c, a, o) => tools.run(c === "git" ? GIT : c, a, o) }, sleep, pollSec: 0.01 });
  assert.ok(polls >= 1);
  const res = JSON.parse(bucket.get("result.json"));
  const j = JSON.parse(bucket.get("job.json"));
  const v = R.verifyResult({ job: { manifest: j.manifest }, result: res.result, signature: res.signature, evidence: j.evidence, dispute: 4, commitBytes32: "0x" + commit.padEnd(64, "0"), commands: ["make"], verifyAttestation: verify });
  assert.deepStrictEqual({ valid: v.valid, ok: v.ok }, { valid: true, ok: true });
  assert.equal(out.result.treeHash, git(["rev-parse", `${commit}^{tree}`], src).trim(), "the snapshot is exactly the disputed tree");
});
