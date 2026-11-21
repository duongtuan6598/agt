// The exam GRADING trade, core (THIET-KE-NGHE-CHAM-THI.md, joint decision of Claude and Codex, 2026-11-21).
// A grader is a sealed box running an approved GRADER image. For one exam it:
//   1. makes a one-job key and attests a manifest naming the exam, the answers and its image (newGradingJob);
//   2. receives, sealed to that key, ONLY the questions drawn for this exam — never the whole bank (sealPackage);
//   3. grades by building and running the answers in its sandbox, then signs a canonical result (gradeJob);
// and anyone can check a result against its attestation and compare two graders (verifyGrade, agree).
// The private package exists in plaintext only inside the grader's memory; the result carries per-question
// pass/fail and a digest of the observations, never the hidden tests.
const crypto = require("crypto");
const { ethers } = require("ethers");
const S = require("../embedded/secrets.js");
const { canonical } = require("../embedded/builder.js");

const SCHEMA = "agt-grade/v1";
const hashOf = (v) => ethers.keccak256(ethers.toUtf8Bytes(typeof v === "string" ? v : canonical(v)));
const contextOf = (examHash, nonce) => `grade:${examHash}:${nonce}`;

/// The package a grader receives: the bank's settings and only the drawn questions (with their hidden tests).
function packageFor(bank, drawn) {
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  const questions = drawn.map((id) => {
    if (!byId.has(id)) throw new Error(`question ${id} is not in the bank`);
    return byId.get(id);
  });
  const { questions: _all, ...settings } = bank;
  return { ...settings, questions };
}

function newGradingJob({ examHash, drawn, answers, imageDigest }) {
  if (!/^0x[0-9a-f]{64}$/.test(examHash)) throw new Error("bad exam hash");
  if (!Array.isArray(drawn) || !drawn.length) throw new Error("no drawn questions");
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const sealPub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  const signer = ethers.Wallet.createRandom();
  const manifest = {
    agt: "grader-v1", examHash, drawn: [...drawn], answersHash: hashOf(answers), imageDigest: imageDigest || null,
    sealPubKey: sealPub.toString("base64"), signer: signer.address, nonce: crypto.randomBytes(16).toString("hex"),
  };
  return { manifest, sealPriv: privateKey, signer };
}

/// The custodian's side (whoever holds the bank: today the exam operator, later threshold key holders): seal the
/// drawn questions to an ATTESTED grader's job key. The caller must have verified the grader first.
function sealPackage({ bank, manifest }) {
  const pkg = packageFor(bank, manifest.drawn);
  return { box: S.seal(manifest.sealPubKey, JSON.stringify(pkg), contextOf(manifest.examHash, manifest.nonce)), packageHash: hashOf(pkg) };
}

/// Inside the grader: open the package, check it is exactly the drawn questions, grade, sign.
///   grade(pkg, drawn, answers) → { passed, total, results: [{ id, pass, why, observed? }] }  (exam/embedded.js gradeExam)
async function gradeJob({ job, sealed, answers, grade }) {
  const m = job.manifest;
  if (hashOf(answers) !== m.answersHash) throw new Error("these are not the answers this job was attested for");
  const pkg = JSON.parse(S.open(job.sealPriv, sealed.box, contextOf(m.examHash, m.nonce)));
  if (hashOf(pkg) !== sealed.packageHash) throw new Error("package hash mismatch");
  if (canonical(pkg.questions.map((q) => q.id)) !== canonical(m.drawn)) throw new Error("the package is not exactly the drawn questions");
  const g = await grade(pkg, m.drawn, answers);
  const result = {
    schema: SCHEMA, examHash: m.examHash, answersHash: m.answersHash, packageHash: sealed.packageHash, imageDigest: m.imageDigest,
    nonce: m.nonce, passMark: pkg.passMark, passed: Number(g.passed), total: Number(g.total),
    questions: g.results.map((r) => ({ id: r.id, pass: !!r.pass, observed: hashOf(String(r.observed ?? r.why ?? "")) })),
  };
  result.licensable = result.passed >= Number(pkg.passMark);
  const signature = await job.signer.signMessage(`AGT grade ${hashOf(result)}`);
  return { result, signature };
}

/// Anyone: is this a genuine grading of THIS exam by an attested, approved grader? (no secrets needed)
function verifyGrade({ manifest, evidence, result, signature, expected, verifyAttestation }) {
  const why = [];
  if (!verifyAttestation(manifest, evidence)) why.push("the grader is not an attested, approved grader image");
  let signer = null;
  try { signer = ethers.verifyMessage(`AGT grade ${hashOf(result)}`, signature); } catch {}
  if (!signer || signer !== manifest.signer) why.push("not signed by the attested job key");
  if (result.schema !== SCHEMA) why.push("unknown result schema");
  if (result.examHash !== expected.examHash || manifest.examHash !== expected.examHash) why.push("another exam");
  if (result.answersHash !== expected.answersHash || manifest.answersHash !== expected.answersHash) why.push("other answers");
  if (canonical(manifest.drawn) !== canonical(expected.drawn) || canonical(result.questions.map((q) => q.id)) !== canonical(expected.drawn)) why.push("other questions");
  if (result.nonce !== manifest.nonce || result.imageDigest !== manifest.imageDigest) why.push("result does not belong to this job");
  if (result.passed !== result.questions.filter((q) => q.pass).length || result.total !== expected.drawn.length) why.push("counts do not match the questions");
  if (result.licensable !== (result.passed >= result.passMark)) why.push("licensable does not follow the pass mark");
  return { valid: why.length === 0, why };
}

/// Objective trades: two graders agree only if, for the same package and the same answers, every question's
/// verdict is identical. Observation digests are kept for audit but not compared: a run embeds a fresh random
/// marker (exam/embedded.js), so honest graders' raw observations differ. Any difference goes to a third grader
/// and drawn reviewers.
function agree(a, b) {
  const key = (r) => canonical({ packageHash: r.packageHash, answersHash: r.answersHash, passMark: r.passMark, verdicts: r.questions.map((q) => [q.id, q.pass]) });
  return key(a) === key(b);
}

module.exports = { newGradingJob, sealPackage, gradeJob, verifyGrade, agree, packageFor, hashOf, contextOf, SCHEMA };
