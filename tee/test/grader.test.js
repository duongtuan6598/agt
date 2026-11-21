// The grading trade core (tee/grader/grader.js) with a fake bank and a fake grading function: the package holds only
// the drawn questions, results bind exam/answers/package/job, and two honest graders agree while a lying one does not.
const test = require("node:test");
const assert = require("node:assert");
const G = require("../grader/grader.js");

const bank = { trade: 6, kind: "embedded", passMark: 2, questionsPerExam: 3, questions: ["q1", "q2", "q3", "q4", "q5"].map((id) => ({ id, task: `task ${id}`, hidden: { expect: [`secret-${id}`] } })) };
const drawn = ["q2", "q4", "q5"];
const answers = { q2: "a2", q4: "a4", q5: "a5" };
const examHash = "0x" + "e".repeat(64);
const IMAGE = "sha256:" + "9".repeat(64);
// honest grading: deterministic verdicts, a random marker in the observations (like exam/embedded.js)
const honest = async (pkg, ids, ans) => ({ passed: 2, total: 3, results: ids.map((id) => ({ id, pass: id !== "q4", observed: `run ${Math.random()} for ${ans[id]}` })) });
const attestedOk = () => true;
const expected = { examHash, answersHash: G.hashOf(answers), drawn };

async function gradeOnce(grade = honest) {
  const job = G.newGradingJob({ examHash, drawn, answers, imageDigest: IMAGE });
  const sealed = G.sealPackage({ bank, manifest: job.manifest });
  const out = await G.gradeJob({ job, sealed, answers, grade });
  return { job, sealed, ...out };
}

test("the grader receives only the drawn questions, sealed to its job key", async () => {
  const job = G.newGradingJob({ examHash, drawn, answers, imageDigest: IMAGE });
  const sealed = G.sealPackage({ bank, manifest: job.manifest });
  const text = JSON.stringify(sealed.box);
  for (const id of ["q1", "q3"]) assert.ok(!text.includes(`secret-${id}`));
  let seen;
  await G.gradeJob({ job, sealed, answers, grade: async (pkg, ids) => { seen = pkg.questions.map((q) => q.id); return honest(pkg, ids, answers); } });
  assert.deepStrictEqual(seen, drawn, "only the drawn questions, in order");
  const other = G.newGradingJob({ examHash, drawn, answers, imageDigest: IMAGE });
  await assert.rejects(G.gradeJob({ job: other, sealed, answers, grade: honest }), "another job's key cannot open it");
});

test("a signed result is checked against the exam, the answers, the questions and the job", async () => {
  const { job, result, signature } = await gradeOnce();
  const v = (over = {}, r = result) => G.verifyGrade({ manifest: job.manifest, evidence: {}, result: r, signature, expected: { ...expected, ...over }, verifyAttestation: attestedOk });
  assert.deepStrictEqual(v(), { valid: true, why: [] });
  assert.equal(result.licensable, true);
  assert.equal(v({ examHash: "0x" + "f".repeat(64) }).valid, false);
  assert.equal(v({ answersHash: G.hashOf({ q2: "x" }) }).valid, false);
  assert.equal(v({}, { ...result, passed: 3 }).valid, false, "an edited result loses its signature");
  assert.equal(G.verifyGrade({ manifest: job.manifest, evidence: {}, result, signature, expected, verifyAttestation: () => false }).valid, false, "unattested grader");
  await assert.rejects(G.gradeJob({ job, sealed: (await gradeOnce()).sealed, answers, grade: honest }), "a package sealed for another job is refused");
  await assert.rejects(G.gradeJob({ job, sealed: G.sealPackage({ bank, manifest: job.manifest }), answers: { ...answers, q2: "changed" }, grade: honest }), /not the answers/);
});

test("two honest graders agree despite random markers; a grader that flips a verdict does not", async () => {
  const a = await gradeOnce();
  const b = await gradeOnce();
  assert.notEqual(a.result.questions[0].observed, b.result.questions[0].observed, "raw observations differ");
  assert.equal(G.agree(a.result, b.result), true);
  const liar = await gradeOnce(async (pkg, ids, ans) => ({ passed: 3, total: 3, results: ids.map((id) => ({ id, pass: true, observed: "x" })) }));
  assert.equal(G.agree(a.result, liar.result), false);
});
