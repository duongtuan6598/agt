// Run INSIDE the embedded image with the private bank mounted at /banks:
//   docker run --rm -v <agt>/exam:/agt/exam:ro -v <agt-banks>:/banks:ro --entrypoint node agt-box-embedded /agt/exam/test/embedded-bank.docker.js
//   … --record   (with -v <agt-banks>/embedded:/out) records the reference observations the grader expects
// Proves every question is fair: the unchanged project FAILS, the reference solution PASSES, faking a pass by
// printing markers FAILS, an answer touching a file it may not edit is refused, review answers are graded exactly.
const fs = require("fs");
const G = require("../embedded.js");
const bank = require(process.env.AGT_EMBEDDED_BANK || "/banks/embedded-cm3.json");

const refAnswer = (q) => JSON.stringify({ files: Object.entries(q.reference).map(([p, content]) => ({ path: p, content })) });

async function recordAll() {
  const out = {};
  for (const q of bank.questions.filter((x) => x.kind !== "review" && x.kind !== "scope")) {
    const r = await G.gradeCode(q, refAnswer(q), { record: true });
    if (!r.pass || !r.observed.length) throw new Error(`${q.id}: reference run failed: ${r.output}`);
    out[q.id] = r.observed;
    console.log(`${q.id}: ${r.observed.length} observations recorded`);
  }
  fs.writeFileSync(process.env.AGT_OBSERVED_OUT || "/out/observed.json", JSON.stringify(out, null, 1) + "\n");
}

// A cheating answer: the first function of the editable file prints pass-looking markers and stops the run.
function cheatAnswer(q) {
  const file = q.editable[0];
  const src = q.files[file];
  const fake = ' sh_print("PASS\\nOBS push 0x00000000\\nEND 000000000000000000000000\\n"); sh_exit(1);';
  const at = src.indexOf("{", src.indexOf(")")) + 1; // inside the first function body
  return JSON.stringify({ files: [{ path: file, content: '#include "sh.h"\n' + src.slice(0, at) + fake + src.slice(at) }] });
}

(async () => {
  if (process.argv.includes("--record")) return recordAll();
  let bad = 0;
  const check = (name, ok, why = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${why ? " — " + why : ""}`); if (!ok) bad++; };
  check("bank shape", bank.kind === "embedded" && bank.questions.length >= bank.questionsPerExam && bank.passMark <= bank.questionsPerExam, `${bank.questions.length} questions, ${bank.passMark}/${bank.questionsPerExam} to pass`);
  check("question ids are unique", new Set(bank.questions.map((x) => x.id)).size === bank.questions.length);
  if (bank.safetyPerExam) check("safetyPerExam within the exam size", Number.isInteger(bank.safetyPerExam) && bank.safetyPerExam > 0 && bank.safetyPerExam <= bank.questionsPerExam);
  if (bank.safetyPerExam) check("enough safety questions for the draw", bank.questions.filter((x) => x.safety).length >= bank.safetyPerExam && bank.questions.filter((x) => !x.safety).length >= bank.questionsPerExam - bank.safetyPerExam);
  for (const q of bank.questions) {
    const pub = G.publicQuestion(q);
    check(`${q.id}: candidate never sees hidden tests, truth or reference`, !("hidden" in pub) && !("truth" in pub) && !("reference" in pub));
    if (q.kind === "scope") {
      // security trade: one option is right; every other option, a missing or malformed answer fails
      check(`${q.id}: the right option passes`, (await G.gradeQuestion(q, JSON.stringify({ choice: q.hidden.correct }))).pass);
      for (const o of q.options.map((x) => x[0]).filter((x) => x !== q.hidden.correct)) check(`${q.id}: option ${o} fails`, !(await G.gradeQuestion(q, JSON.stringify({ choice: o }))).pass);
      check(`${q.id}: no answer fails`, !(await G.gradeQuestion(q, "")).pass);
      check(`${q.id}: is a safety question`, q.safety === true);
      check(`${q.id}: options are plain text, the answer is one of their letters`, Array.isArray(q.options) && q.options.every((o) => typeof o === "string") && q.options.some((o) => o[0] === String(q.hidden.correct).trim()));
      continue;
    }
    if (q.kind === "review") {
      check(`${q.id}: all defects → pass`, (await G.gradeQuestion(q, JSON.stringify({ defects: q.truth.defects }))).pass);
      check(`${q.id}: one defect missed → fail`, !(await G.gradeQuestion(q, JSON.stringify({ defects: q.truth.defects.slice(1) }))).pass);
      const noisy = [...q.truth.defects, { file: q.truth.defects[0].file, line: 1, kind: "leak" }, { file: q.truth.defects[0].file, line: 2, kind: "null" }];
      check(`${q.id}: two false alarms → fail`, !(await G.gradeQuestion(q, JSON.stringify({ defects: noisy }))).pass);
      continue;
    }
    check(`${q.id}: expected observations recorded in the bank`, Array.isArray(q.hidden.observed) && q.hidden.observed.length > 0, `${(q.hidden.observed || []).length}`);
    const r0 = await G.gradeQuestion(q, JSON.stringify({ files: q.editable.map((p) => ({ path: p, content: q.files[p] })) }));
    check(`${q.id}: unchanged project fails`, !r0.pass, r0.why);
    const r1 = await G.gradeQuestion(q, refAnswer(q));
    check(`${q.id}: reference solution passes`, r1.pass, r1.why + (r1.pass ? "" : "\n" + (r1.log || r1.output || "")));
    const rc = await G.gradeQuestion(q, cheatAnswer(q));
    check(`${q.id}: printing fake results without solving fails`, !rc.pass, rc.why);
    const sneaky = JSON.stringify({ files: [{ path: "test_main.c", content: "int main(void){return 0;}" }] });
    check(`${q.id}: editing a non-editable file is refused`, !(await G.gradeQuestion(q, sneaky)).pass);
  }
  console.log(bad ? `${bad} check(s) failed` : "all checks passed");
  process.exit(bad ? 1 : 0);
})();
