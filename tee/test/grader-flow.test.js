// The grader's supervisor end to end, without a cloud: we play the attestation service with our own RSA key; the
// bank's custodian verifies the grader (policy.graderImages) before sealing the drawn questions; two honest graders
// agree; a grader whose sandbox could reach a TEE socket refuses before doing anything.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const T = require("../verify.js");
const G = require("../grader/grader.js");
const { gradeOne } = require("../grader/main.js");
const { makeVerifyGrader, makeVerifyBuilder } = require("../builder/verify-builder.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = [{ ...publicKey.export({ format: "jwk" }), kid: "k", alg: "RS256", use: "sig" }];
const GRADER = "sha256:" + "6".repeat(64);
const now = Math.floor(Date.now() / 1000);
const sign = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k", typ: "JWT" }) + "." + enc(claims);
  return head + "." + crypto.sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url");
};
const attest = (image = GRADER) => async (nonce) => ({ token: sign({ iss: T.ISSUER, aud: T.AUDIENCE, iat: now, nbf: now, exp: now + 3600, swname: "CONFIDENTIAL_SPACE", hwmodel: "GCP_AMD_SEV", dbgstat: "disabled-since-boot", secboot: true, submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: image, restart_policy: "Never" } }, eat_nonce: nonce }) });
const policy = { audience: T.AUDIENCE, hwmodels: ["GCP_AMD_SEV"], imageDigests: [], graderImages: [GRADER], builderImages: [] };
const verifyGrader = makeVerifyGrader({ jwks, policy });

const bank = { trade: 6, kind: "embedded", passMark: 2, questions: ["q1", "q2", "q3", "q4"].map((id) => ({ id, hidden: { expect: [`secret-${id}`] } })) };
const exam = { examHash: "0x" + "c".repeat(64), drawn: ["q1", "q3", "q4"], answers: { q1: "a", q3: "b", q4: "c" } };
const commit = G.examCommitments({ bank, drawn: exam.drawn, answers: exam.answers });
const grade = async (pkg, ids) => ({ results: ids.map((id) => ({ id, pass: id !== "q3" })) });

// the exam service + custodian, in memory: each grading job has its own id; the custodian verifies before sealing
function service() {
  const jobs = new Map();
  const results = [];
  let n = 0;
  const expectedFor = (job) => ({ job, examHash: exam.examHash, drawn: exam.drawn, packageHash: commit.packageHash, answersHash: commit.answersHash, passMark: bank.passMark });
  return {
    results, expectedFor,
    io: {
      nextJob: async () => ({ job: `job-${String(++n).padStart(8, "0")}`, ...exam, packageHash: commit.packageHash, answersHash: commit.answersHash, salt: commit.salt }),
      postJob: async ({ manifest, evidence, signature }) => {
        const sealed = G.sealPackage({ bank, manifest, evidence, jobSignature: signature, expected: expectedFor(manifest.job), verifyGrader });
        jobs.set(manifest.nonce, { manifest, evidence, sealed });
      },
      getPackage: async (nonce) => (jobs.get(nonce) || {}).sealed || null,
      postResult: async (nonce, out) => results.push({ ...jobs.get(nonce), ...out }),
    },
  };
}
const ok = async () => ({ ok: true, failures: [] });

test("two attested graders grade the same exam; anyone can verify each; they agree", async () => {
  const s = service();
  for (let i = 0; i < 2; i++) await gradeOne({ io: s.io, attest: attest(), grade, imageDigest: GRADER, isolationProbe: ok, pollSec: 0 });
  assert.equal(s.results.length, 2);
  for (const r of s.results) {
    const v = G.verifyGrade({ manifest: r.manifest, evidence: r.evidence, result: r.result, signature: r.signature, expected: s.expectedFor(r.manifest.job), verifyAttestation: verifyGrader });
    assert.deepStrictEqual(v, { valid: true, why: [] });
  }
  assert.equal(G.agree(s.results[0].result, s.results[1].result), true);
});

test("the custodian seals nothing for an unapproved image or a builder image", async () => {
  const s = service();
  await assert.rejects(gradeOne({ io: s.io, attest: attest("sha256:" + "1".repeat(64)), grade, imageDigest: "sha256:" + "1".repeat(64), isolationProbe: ok, pollSec: 0 }), /refusing to seal: not an attested, approved grader/);
  assert.equal(makeVerifyBuilder({ jwks, policy: { ...policy, builderImages: [GRADER] } })({ agt: "grader-v1" }, {}), false, "a grader manifest is never a builder");
});

test("a grader whose sandbox can reach a TEE socket refuses before taking a job", async () => {
  const s = service();
  let took = 0;
  const io = { ...s.io, nextJob: async () => { took++; return exam; } };
  await assert.rejects(gradeOne({ io, attest: attest(), grade, imageDigest: GRADER, isolationProbe: async () => ({ ok: false, failures: ["the sandbox can reach the TEE socket"] }), pollSec: 0 }), /refusing to grade/);
  assert.equal(took, 0);
});
