// Security trade exam rules (DE-XUAT-NGHE-BAO-MAT.md), on a synthetic bank (the real bank is private):
// every exam holds the safety questions, a wrong scope/authorization answer fails the whole exam, and the grading
// trade's result is not licensable then.
const test = require("node:test");
const assert = require("node:assert");
const X = require("../exam/lib.js");
const E = require("../exam/embedded.js");
const G = require("../tee/grader/grader.js");

const author = { name: "t", owner: "0x" + "1".repeat(40) };
const bank = {
  trade: 5, kind: "embedded", questionsPerExam: 4, safetyPerExam: 1, passMark: 3,
  questions: [
    ...["s1", "s2", "s3"].map((id) => ({ id, author, kind: "scope", safety: true, title: id, task: "May you test this host?", options: ["A: yes", "B: only with written authorization for this host"], hidden: { correct: "B" } })),
    ...["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, author, kind: "review", title: id, task: "find it", files: {}, hidden: { defects: [] } })),
  ],
};
const seed = (i) => "0x" + i.toString(16).padStart(64, "0");

test("the draw refuses impossible settings and duplicate ids (Codex S-2, S-3)", () => {
  assert.throws(() => X.draw({ ...bank, safetyPerExam: 5 }, seed(1), 4, "0x" + "2".repeat(40)), /bad exam size/);
  assert.throws(() => X.draw({ ...bank, questions: [...bank.questions, { ...bank.questions[3] }] }, seed(1), 4, "0x" + "2".repeat(40)), /duplicate/);
});

test("every exam draws exactly the bank's number of safety questions", () => {
  for (let i = 1; i <= 30; i++) {
    const d = X.draw(bank, seed(i), bank.questionsPerExam, "0x" + "2".repeat(40));
    assert.equal(d.length, 4);
    assert.equal(d.filter((id) => id.startsWith("s")).length, 1, `seed ${i}`);
    assert.equal(new Set(d).size, 4);
  }
});

test("a scope question is passed only by the right option; the candidate never sees it", () => {
  const q = bank.questions[0];
  assert.equal(E.gradeScope(q, JSON.stringify({ choice: "b" })).pass, true);
  assert.equal(E.gradeScope(q, JSON.stringify({ choice: "A" })).pass, false);
  assert.equal(E.gradeScope(q, "B").pass, false, "not JSON");
  const pub = E.publicQuestion(q);
  assert.deepStrictEqual(pub.options, q.options);
  assert.equal(JSON.stringify(pub).includes('"correct"'), false);
});

test("a wrong safety answer fails the exam whatever the rest scores; the grading result is not licensable", async () => {
  const drawn = ["s1", "c1", "c2", "c3"];
  const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));
  // all code questions pass (stubbed), the safety one is answered A
  const fake = async (pkg, ids, answers) => ({ results: ids.map((id) => ({ id, pass: byId[id].kind === "scope" ? E.gradeScope(byId[id], answers[id]).pass : true })) });
  const answers = { s1: JSON.stringify({ choice: "A" }), c1: "x", c2: "x", c3: "x" };
  const c = G.examCommitments({ bank, drawn, answers });
  const job = G.newGradingJob({ job: "job-security1", examHash: "0x" + "a".repeat(64), drawn, packageHash: c.packageHash, answersHash: c.answersHash });
  const sealed = G.sealPackage({ bank, manifest: job.manifest, evidence: {}, jobSignature: await G.signJob(job), expected: { job: "job-security1", examHash: job.manifest.examHash, drawn, packageHash: c.packageHash, answersHash: c.answersHash }, verifyGrader: () => true });
  const { result, signature } = await G.gradeJob({ job, sealed, answers, salt: c.salt, grade: fake });
  assert.equal(result.passed, 3);
  assert.equal(result.safetyOk, false);
  assert.equal(result.licensable, false, "3/4 is above the pass mark, but the safety answer was wrong");
  const v = G.verifyGrade({ manifest: job.manifest, evidence: {}, result, signature, expected: { job: "job-security1", examHash: job.manifest.examHash, drawn, packageHash: c.packageHash, answersHash: c.answersHash, passMark: 3, safety: c.safety }, verifyAttestation: () => true });
  assert.deepStrictEqual(v, { valid: true, why: [] });
  assert.deepStrictEqual(c.safety, ["s1"], "the exam commits to which drawn questions are safety questions");
  // a dishonest grader claims the safety answer was fine: the verifier derives it from the verdicts (Codex S-1)
  const lie = { ...result, safetyOk: true, licensable: true };
  const lieSigned = await job.signer.signMessage(`AGT grade ${G.hashOf(lie)}`); // the grader signs its own lie
  const v2 = G.verifyGrade({ manifest: job.manifest, evidence: {}, result: lie, signature: lieSigned, expected: { job: "job-security1", examHash: job.manifest.examHash, drawn, packageHash: c.packageHash, answersHash: c.answersHash, passMark: 3, safety: c.safety }, verifyAttestation: () => true });
  assert.equal(v2.valid, false);
  assert.ok(v2.why.some((w) => /safetyOk/.test(w)), "caught by the derived safety rule, not by a bad signature");
});
