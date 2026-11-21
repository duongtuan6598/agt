// The grading trade core (tee/grader/grader.js): the package holds only the drawn questions and allow-listed settings,
// is committed when the exam is drawn, is sealed only to a verified grader for the expected job, and results bind
// job/exam/package/answers; two honest graders agree, a lying one does not (Codex Q-1..Q-5).
const test = require("node:test");
const assert = require("node:assert");
const G = require("../grader/grader.js");

const bank = { trade: 6, kind: "embedded", passMark: 2, questionsPerExam: 3, authorsNote: "never travels", questions: ["q1", "q2", "q3", "q4", "q5"].map((id) => ({ id, task: `task ${id}`, hidden: { expect: [`secret-${id}`] } })) };
const drawn = ["q2", "q4", "q5"];
const answers = { q2: "a2", q4: "a4", q5: "a5" };
const examHash = "0x" + "e".repeat(64);
const IMAGE = "sha256:" + "9".repeat(64);
const commit = G.examCommitments({ bank, drawn, answers });
const exp = (job) => ({ job, examHash, drawn, packageHash: commit.packageHash, answersHash: commit.answersHash, passMark: 2 });
const honest = async (pkg, ids) => ({ results: ids.map((id) => ({ id, pass: id !== "q4" })) });
const approved = () => true;

async function gradeOnce({ job = "job-00000001", grade = honest, verifyGrader = approved } = {}) {
  const j = G.newGradingJob({ job, examHash, drawn, packageHash: commit.packageHash, answersHash: commit.answersHash, imageDigest: IMAGE });
  const sealed = G.sealPackage({ bank, manifest: j.manifest, evidence: {}, jobSignature: await G.signJob(j), expected: exp(job), verifyGrader });
  const out = await G.gradeJob({ job: j, sealed, answers, salt: commit.salt, grade });
  return { j, sealed, ...out };
}

test("the package: only drawn questions and allow-listed settings; distinct ids; committed in advance", async () => {
  const pkg = G.packageFor(bank, drawn);
  assert.deepStrictEqual(pkg.questions.map((q) => q.id), drawn);
  assert.equal(pkg.authorsNote, undefined, "bank fields outside the allow-list never travel");
  assert.throws(() => G.packageFor(bank, ["q2", "q2"]), /distinct/);
  const { sealed } = await gradeOnce();
  for (const id of ["q1", "q3"]) assert.ok(!JSON.stringify(sealed.box).includes(`secret-${id}`));
});

test("the custodian seals nothing unless the grader is verified, signed and asks for exactly this job (Q-1)", async () => {
  const j = G.newGradingJob({ job: "job-00000002", examHash, drawn, packageHash: commit.packageHash, answersHash: commit.answersHash, imageDigest: IMAGE });
  const sig = await G.signJob(j);
  const go = (o) => () => G.sealPackage({ bank, manifest: j.manifest, evidence: {}, jobSignature: sig, expected: exp("job-00000002"), verifyGrader: approved, ...o });
  assert.doesNotThrow(go({}));
  assert.throws(go({ verifyGrader: () => false }), /not an attested/);
  assert.throws(go({ verifyGrader: undefined }), /not an attested/, "no verifier, no package");
  assert.throws(go({ jobSignature: await G.signJob(G.newGradingJob({ job: "job-00000002", examHash, drawn, packageHash: commit.packageHash, answersHash: commit.answersHash })) }), /not signed/);
  assert.throws(go({ expected: exp("job-00000003") }), /job is not this exam's/);
  assert.throws(go({ bank: { ...bank, passMark: 1 } }), /no longer matches/, "a custodian cannot lower the pass mark (Q-2)");
});

test("a result binds the job, exam, package and answers; replay to another job fails (Q-3)", async () => {
  const { j, result, signature } = await gradeOnce();
  const v = (e) => G.verifyGrade({ manifest: j.manifest, evidence: {}, result, signature, expected: e, verifyAttestation: approved });
  assert.deepStrictEqual(v(exp("job-00000001")), { valid: true, why: [] });
  assert.equal(result.licensable, true);
  assert.equal(v(exp("job-00000009")).valid, false, "the same result does not count for another job");
  assert.equal(v({ ...exp("job-00000001"), passMark: 3 }).valid, false);
  assert.equal(JSON.stringify(result).includes("observed"), false, "no observation digests in public (Q-5)");
  assert.notEqual(commit.answersHash, G.hashOf(answers), "answers are committed with a salt (Q-5)");
});

test("two honest graders agree; a grader that flips a verdict does not", async () => {
  const a = await gradeOnce({ job: "job-00000010" });
  const b = await gradeOnce({ job: "job-00000011" });
  assert.equal(G.agree(a.result, b.result), true);
  const liar = await gradeOnce({ job: "job-00000012", grade: async (pkg, ids) => ({ results: ids.map((id) => ({ id, pass: true })) }) });
  assert.equal(G.agree(a.result, liar.result), false);
});
