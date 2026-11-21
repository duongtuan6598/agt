// The exam GRADING trade, core (THIET-KE-NGHE-CHAM-THI.md, joint decision of Claude and Codex, 2026-11-21).
// A grader is a sealed box running an approved GRADER image. For one grading job it:
//   1. makes a one-job key and attests a manifest naming the job, the exam, its committed package and the salted
//      answers commitment (newGradingJob);
//   2. receives, sealed to that key, ONLY the drawn questions — and only after the custodian has verified the grader
//      (sealPackage refuses otherwise, Codex Q-1);
//   3. grades in its sandbox and signs a canonical result (gradeJob);
// and anyone can check a result against its attestation and the exam's commitments, and compare two graders.
const crypto = require("crypto");
const { ethers } = require("ethers");
const S = require("../embedded/secrets.js");
const { canonical } = require("../embedded/builder.js");

const SCHEMA = "agt-grade/v2";
const hashOf = (v) => ethers.keccak256(ethers.toUtf8Bytes(typeof v === "string" ? v : canonical(v)));
const contextOf = (job, nonce) => `grade:${job}:${nonce}`;
// The package carries these bank settings and nothing else (Codex Q-4).
const SETTINGS = ["trade", "kind", "passMark", "questionsPerExam", "safetyPerExam", "timeLimitSec", "maxAnswerChars"];
// A salted commitment: a published hash of short or guessable answers would allow offline guessing (Codex Q-5).
const answersCommitment = (answers, salt) => hashOf({ salt, answers });

/// The package for an exam: the allow-listed settings and only the drawn questions, in order.
function packageFor(bank, drawn) {
  if (!Array.isArray(drawn) || !drawn.length || new Set(drawn).size !== drawn.length) throw new Error("drawn questions must be a non-empty list of distinct ids");
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  const questions = drawn.map((id) => {
    if (!byId.has(id)) throw new Error(`question ${id} is not in the bank`);
    return byId.get(id);
  });
  const settings = Object.fromEntries(SETTINGS.filter((k) => bank[k] !== undefined).map((k) => [k, bank[k]]));
  return { ...settings, questions };
}

/// The exam service, when it draws an exam: what it commits to publicly before any grader exists (Codex Q-2).
function examCommitments({ bank, drawn, answers, salt = crypto.randomBytes(16).toString("hex") }) {
  return { packageHash: hashOf(packageFor(bank, drawn)), answersHash: answersCommitment(answers, salt), salt };
}

/// job: a unique grading-job id assigned by the service (one result per job, Codex Q-3).
function newGradingJob({ job, examHash, drawn, packageHash, answersHash, imageDigest }) {
  if (!/^[\w-]{8,80}$/.test(String(job))) throw new Error("bad job id");
  if (!/^0x[0-9a-f]{64}$/.test(examHash) || !/^0x[0-9a-f]{64}$/.test(packageHash) || !/^0x[0-9a-f]{64}$/.test(answersHash)) throw new Error("bad commitments");
  if (!Array.isArray(drawn) || !drawn.length || new Set(drawn).size !== drawn.length) throw new Error("bad drawn questions");
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const sealPub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  const signer = ethers.Wallet.createRandom();
  const manifest = {
    agt: "grader-v1", job: String(job), examHash, drawn: [...drawn], packageHash, answersHash, imageDigest: imageDigest || null,
    sealPubKey: sealPub.toString("base64"), signer: signer.address, nonce: crypto.randomBytes(16).toString("hex"),
  };
  return { manifest, sealPriv: privateKey, signer };
}
const jobMessage = (manifest) => `AGT grading job ${hashOf(manifest)}`;
async function signJob(job) {
  return job.signer.signMessage(jobMessage(job.manifest));
}

/// The custodian (whoever holds the bank): seals ONLY to a verified grader, for exactly the expected job and exam.
///   expected: { job, examHash, drawn, packageHash, answersHash }   verifyGrader(manifest, evidence) → bool
function sealPackage({ bank, manifest, evidence, jobSignature, expected, verifyGrader }) {
  if (typeof verifyGrader !== "function" || !verifyGrader(manifest, evidence)) throw new Error("refusing to seal: not an attested, approved grader");
  let signer = null;
  try { signer = ethers.verifyMessage(jobMessage(manifest), jobSignature); } catch {}
  if (!signer || signer !== manifest.signer) throw new Error("refusing to seal: the job is not signed by its attested key");
  for (const k of ["job", "examHash", "packageHash", "answersHash"]) if (manifest[k] !== expected[k]) throw new Error(`refusing to seal: ${k} is not this exam's`);
  if (canonical(manifest.drawn) !== canonical(expected.drawn)) throw new Error("refusing to seal: other questions");
  const pkg = packageFor(bank, manifest.drawn);
  if (hashOf(pkg) !== expected.packageHash) throw new Error("refusing to seal: the bank no longer matches the exam's committed package");
  return { box: S.seal(manifest.sealPubKey, JSON.stringify(pkg), contextOf(manifest.job, manifest.nonce)) };
}

/// Inside the grader: open the package, check it against the commitments, grade, sign.
///   grade(pkg, drawn, answers) → { results: [{ id, pass }] }  (exam/embedded.js gradeExam)
async function gradeJob({ job, sealed, answers, salt, grade }) {
  const m = job.manifest;
  if (answersCommitment(answers, salt) !== m.answersHash) throw new Error("these are not the answers this job was attested for");
  const pkg = JSON.parse(S.open(job.sealPriv, sealed.box, contextOf(m.job, m.nonce)));
  if (hashOf(pkg) !== m.packageHash) throw new Error("the package is not the one this exam committed to");
  if (canonical(pkg.questions.map((q) => q.id)) !== canonical(m.drawn)) throw new Error("the package is not exactly the drawn questions");
  const g = await grade(pkg, m.drawn, answers);
  const verdict = new Map(g.results.map((r) => [r.id, !!r.pass]));
  const questions = m.drawn.map((id) => ({ id, pass: verdict.get(id) === true })); // no observations in public (Codex Q-5)
  const passed = questions.filter((q) => q.pass).length;
  // a wrong answer to a safety question fails the exam whatever the rest scores (security trade)
  const safe = new Set(pkg.questions.filter((q) => q.safety).map((q) => q.id));
  const safetyOk = questions.every((q) => !safe.has(q.id) || q.pass);
  const result = {
    schema: SCHEMA, job: m.job, examHash: m.examHash, packageHash: m.packageHash, answersHash: m.answersHash, imageDigest: m.imageDigest,
    nonce: m.nonce, passMark: Number(pkg.passMark), passed, total: questions.length, questions,
    safetyOk, licensable: passed >= Number(pkg.passMark) && safetyOk,
  };
  const signature = await job.signer.signMessage(`AGT grade ${hashOf(result)}`);
  return { result, signature };
}

/// Anyone: is this a genuine grading of THIS job of THIS exam by an attested, approved grader? (no secrets needed)
///   expected: { job, examHash, drawn, packageHash, answersHash, passMark }
function verifyGrade({ manifest, evidence, result, signature, expected, verifyAttestation }) {
  const why = [];
  if (!verifyAttestation(manifest, evidence)) why.push("the grader is not an attested, approved grader image");
  let signer = null;
  try { signer = ethers.verifyMessage(`AGT grade ${hashOf(result)}`, signature); } catch {}
  if (!signer || signer !== manifest.signer) why.push("not signed by the attested job key");
  if (result.schema !== SCHEMA) why.push("unknown result schema");
  for (const k of ["job", "examHash", "packageHash", "answersHash"]) if (result[k] !== expected[k] || manifest[k] !== expected[k]) why.push(`${k} is not this one`);
  if (canonical(manifest.drawn) !== canonical(expected.drawn) || canonical(result.questions.map((q) => q.id)) !== canonical(expected.drawn)) why.push("other questions");
  if (result.nonce !== manifest.nonce || result.imageDigest !== manifest.imageDigest) why.push("result does not belong to this grader's job");
  if (result.passMark !== expected.passMark) why.push("another pass mark");
  if (result.passed !== result.questions.filter((q) => q.pass).length || result.total !== expected.drawn.length) why.push("counts do not match the questions");
  if (typeof result.safetyOk !== "boolean" || result.licensable !== (result.passed >= result.passMark && result.safetyOk)) why.push("licensable does not follow the pass mark and the safety questions");
  return { valid: why.length === 0, why };
}

/// Objective trades: two graders agree only if, for the same committed package and answers, every verdict matches.
function agree(a, b) {
  const key = (r) => canonical({ examHash: r.examHash, packageHash: r.packageHash, answersHash: r.answersHash, passMark: r.passMark, safetyOk: r.safetyOk, verdicts: r.questions.map((q) => [q.id, q.pass]) });
  return key(a) === key(b);
}

module.exports = { newGradingJob, signJob, sealPackage, gradeJob, verifyGrade, agree, packageFor, examCommitments, answersCommitment, hashOf, contextOf, SCHEMA, SETTINGS };
