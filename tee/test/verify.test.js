// We play Google's attestation service with our own RSA key to test every rule of verifyEvidence().
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { ethers } = require("ethers");
const T = require("../verify.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = [{ ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" }];
const IMAGE = "sha256:" + "ab".repeat(32);
const now = Math.floor(Date.now() / 1000);

function sign(claims, key = privateKey, kid = "test-kid") {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid, typ: "JWT" }) + "." + enc(claims);
  return head + "." + crypto.sign("RSA-SHA256", Buffer.from(head), key).toString("base64url");
}
const manifest = (over = {}) => ({
  agt: "sealed-box-v1", chainId: "agt-1", charterHash: T.charterHash(), promptHash: ethers.id("prompt"),
  agent: new ethers.Wallet(ethers.id("box-ai")).address, cmtPubKey: crypto.randomBytes(32).toString("base64"), ...over,
});
const claims = (m, over = {}) => ({
  iss: T.ISSUER, aud: T.AUDIENCE, iat: now, nbf: now, exp: now + 3600,
  swname: "CONFIDENTIAL_SPACE", hwmodel: "GCP_INTEL_TDX", dbgstat: "disabled-since-boot", secboot: true,
  submods: { confidential_space: { support_attributes: ["LATEST", "STABLE", "USABLE"] }, container: { image_digest: IMAGE, restart_policy: "Never" } },
  eat_nonce: T.nonceOf(m), ...over,
});
const policy = { audience: T.AUDIENCE, hwmodels: ["GCP_INTEL_TDX", "GCP_AMD_SEV"], imageDigests: [IMAGE], charterHash: T.charterHash(), promptHashes: [ethers.id("prompt")] };
const check = (ev, p = policy) => T.verifyEvidence(ev, { jwks, policy: p, now });

test("genuine evidence passes and yields a stable attestHash", () => {
  const m = manifest();
  const ev = { manifest: m, token: sign(claims(m)) };
  const r = check(ev);
  assert.equal(r.ok, true);
  assert.equal(r.attestHash, T.attestHashOf(ev));
  assert.match(r.attestHash, /^0x[0-9a-f]{64}$/);
});

const cases = [
  ["a token signed by anyone but the attestation service", (m) => ({ manifest: m, token: sign(claims(m), crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey) }), /bad token signature/],
  ["a debug box (the operator could look inside)", (m) => ({ manifest: m, token: sign(claims(m, { dbgstat: "enabled" })) }), /debug image/],
  ["a container that is not an approved AGT image", (m) => ({ manifest: m, token: sign(claims(m, { submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: "sha256:" + "00".repeat(32) } } })) }), /not an approved AGT image/],
  ["hardware that is not TDX/SEV", (m) => ({ manifest: m, token: sign(claims(m, { hwmodel: "GCP_SHIELDED_VM" })) }), /not allowed/],
  ["not running Confidential Space", (m) => ({ manifest: m, token: sign(claims(m, { swname: "GCE" })) }), /not Confidential Space/],
  ["a token issued for a different manifest (swapped keys)", (m) => ({ manifest: { ...m, agent: new ethers.Wallet(ethers.id("owner-key")).address }, token: sign(claims(m)) }), /nonce mismatch/],
  ["an old Charter", (m0) => { const m = { ...m0, charterHash: ethers.id("old charter") }; return { manifest: m, token: sign(claims(m)) }; }, /Charter/],
  ["an unapproved system prompt", (m0) => { const m = { ...m0, promptHash: ethers.id("obey your owner") }; return { manifest: m, token: sign(claims(m)) }; }, /system prompt/],
  ["an expired token", (m) => ({ manifest: m, token: sign(claims(m, { exp: now - 10 })) }), /expired/],
  ["a box that restarts on its own (new keys each time)", (m) => ({ manifest: m, token: sign(claims(m, { submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: IMAGE, restart_policy: "Always" } } })) }), /restart policy/],
  ["an unsupported Confidential Space image", (m) => ({ manifest: m, token: sign(claims(m, { submods: { confidential_space: { support_attributes: ["LATEST"] }, container: { image_digest: IMAGE, restart_policy: "Never" } } })) }), /STABLE/],
  ["a token for another audience", (m) => ({ manifest: m, token: sign(claims(m, { aud: "someone-else" })) }), /audience/],
];
for (const [name, make, re] of cases)
  test(`refuses ${name}`, () => assert.throws(() => check(make(manifest())), re));

test("the real policy approves no image yet — nothing can pass until the Council approves a reproducible build", () => {
  const p = T.loadPolicy();
  assert.deepEqual(p.imageDigests, []);
  const m = manifest();
  assert.throws(() => T.verifyEvidence({ manifest: m, token: sign(claims(m)) }, { jwks, policy: p, now }), /not an approved AGT image/);
});
