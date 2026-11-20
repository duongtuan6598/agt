// Embedded exam wiring that needs no toolchain (the build-and-run grading is proven in embedded-bank.docker.js).
const test = require("node:test");
const assert = require("node:assert");
const X = require("../lib.js");
const G = require("../embedded.js");
const M = require("../../tee/box/models.js");

const BANK = {
  trade: 6, kind: "embedded", questionsPerExam: 2, passMark: 2, timeLimitSec: 600,
  questions: [
    { id: "a", kind: "fix", title: "t", task: "fix it", target: "cortex-m3", author: { owner: "0x01" }, files: { "a.c": "x" }, editable: ["a.c"], hidden: { files: { "t.c": "secret test" }, build: "make", expect: ["PASS"] }, reference: { "a.c": "y" } },
    { id: "r", kind: "review", title: "t", task: "review", target: "cortex-m3", author: { owner: "0x01" }, files: { "r.c": "z" }, editable: [], truth: { defects: [{ file: "r.c", line: 10, kind: "race" }, { file: "r.c", line: 20, kind: "overflow" }] } },
    { id: "b", kind: "budget", title: "t", task: "fit", target: "cortex-m3", author: { owner: "0x02" }, files: { "b.c": "x" }, editable: ["b.c"], hidden: { files: {}, build: "make", expect: ["PASS"], flashLimit: 3072 }, reference: { "b.c": "y" } },
  ],
};

test("the candidate sees the project and the task, never the hidden tests, the truth or the reference", () => {
  for (const q of BANK.questions) {
    const p = X.publicQuestion(BANK, q);
    assert.ok(!("hidden" in p) && !("truth" in p) && !("reference" in p));
    assert.deepStrictEqual(p.files, q.files);
  }
  assert.equal(X.publicQuestion(BANK, BANK.questions[2]).flashLimit, 3072);
});

test("the exam service cannot grade embedded answers: the record waits for grading in the box image", () => {
  const g = X.gradeExam(BANK, ["a", "r"], { a: "{}", r: "{}" });
  assert.equal(g.status, "awaiting-grading");
  assert.equal(g.passed, 0);
});

test("questions written by the candidate's own owner are never drawn", () => {
  for (let i = 0; i < 20; i++) {
    const d = X.draw(BANK, X.seedOf("0x" + "11".repeat(32), "0x02", "e" + i, "seed-" + i), 2, "0x02");
    assert.ok(!d.includes("b"));
  }
});

test("review grading: every defect within one line, right kind; at most one false alarm", async () => {
  const q = BANK.questions[1];
  const ans = (d) => JSON.stringify({ defects: d });
  assert.ok((await G.gradeQuestion(q, ans([{ file: "r.c", line: 11, kind: "race" }, { file: "r.c", line: 20, kind: "overflow" }]))).pass);
  assert.ok((await G.gradeQuestion(q, ans([{ file: "r.c", line: 10, kind: "race" }, { file: "r.c", line: 20, kind: "overflow" }, { file: "r.c", line: 3, kind: "leak" }]))).pass);
  assert.ok(!(await G.gradeQuestion(q, ans([{ file: "r.c", line: 10, kind: "race" }, { file: "r.c", line: 20, kind: "leak" }]))).pass); // wrong kind
  assert.ok(!(await G.gradeQuestion(q, ans([{ file: "r.c", line: 13, kind: "race" }, { file: "r.c", line: 20, kind: "overflow" }]))).pass); // too far
  assert.ok(!(await G.gradeQuestion(q, "not json")).pass);
});

test("code answers may only replace editable files, never with paths outside the project", async () => {
  const q = BANK.questions[0];
  const noTools = { tools: { build: async () => { throw new Error("must not build"); } } };
  assert.match((await G.gradeQuestion(q, JSON.stringify({ files: [{ path: "t.c", content: "x" }] }), noTools)).why, /may not be changed/);
  assert.match((await G.gradeQuestion(q, JSON.stringify({ files: [{ path: "../../etc/passwd", content: "x" }] }), noTools)).why, /may not be changed/);
  assert.match((await G.gradeQuestion(q, "{}", noTools)).why, /not \{files/);
});

test("the sealed AI answers embedded items as structured JSON (files or defects)", async () => {
  const calls = [];
  const client = { beta: { messages: { create: async (r) => (calls.push(r), { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r.output_config.format.schema === M.DEFECTS_SCHEMA ? { defects: [{ file: "r.c", line: 10, kind: "race" }] } : { files: [{ path: "a.c", content: "fixed" }] }) }] }) } } };
  const model = M.makeModel({ provider: "anthropic", client, systemPrompt: "charter" });
  const paper = { task: "embedded exam" };
  const code = JSON.parse(await model.answer(X.publicQuestion(BANK, BANK.questions[0]), paper));
  assert.deepStrictEqual(code, { files: [{ path: "a.c", content: "fixed" }] });
  const rev = JSON.parse(await model.answer(X.publicQuestion(BANK, BANK.questions[1]), paper));
  assert.equal(rev.defects[0].kind, "race");
  assert.equal(calls[0].output_config.format.schema, M.CODE_SCHEMA);
  assert.ok(!calls[0].messages[0].content.includes("secret test")); // hidden tests never reach the model
});
