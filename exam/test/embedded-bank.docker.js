// Run INSIDE the embedded image with the private bank mounted at /banks:
//   docker run --rm -v <agt>/exam:/agt/exam:ro -v <agt-banks>:/banks:ro --entrypoint node agt-box-embedded /agt/exam/test/embedded-bank.docker.js
// Proves every question is fair: the unchanged project FAILS the hidden tests, the reference solution PASSES,
// an answer touching a file it may not edit is refused, and review answers are graded exactly.
const G = require("../embedded.js");
const bank = require(process.env.AGT_EMBEDDED_BANK || "/banks/embedded-cm3.json");

(async () => {
  let bad = 0;
  const check = (name, ok, why = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${why ? " — " + why : ""}`); if (!ok) bad++; };
  check("bank shape", bank.kind === "embedded" && bank.questions.length >= bank.questionsPerExam && bank.passMark <= bank.questionsPerExam, `${bank.questions.length} questions, ${bank.passMark}/${bank.questionsPerExam} to pass`);
  for (const q of bank.questions) {
    const pub = G.publicQuestion(q);
    check(`${q.id}: candidate never sees hidden tests, truth or reference`, !("hidden" in pub) && !("truth" in pub) && !("reference" in pub));
    if (q.kind === "review") {
      const truth = JSON.stringify({ defects: q.truth.defects });
      check(`${q.id}: all defects → pass`, (await G.gradeQuestion(q, truth)).pass);
      const missOne = JSON.stringify({ defects: q.truth.defects.slice(1) });
      check(`${q.id}: one defect missed → fail`, !(await G.gradeQuestion(q, missOne)).pass);
      const noisy = JSON.stringify({ defects: [...q.truth.defects, { file: q.truth.defects[0].file, line: 1, kind: "leak" }, { file: q.truth.defects[0].file, line: 2, kind: "null" }] });
      check(`${q.id}: two false alarms → fail`, !(await G.gradeQuestion(q, noisy)).pass);
      continue;
    }
    const unchanged = JSON.stringify({ files: q.editable.map((p) => ({ path: p, content: q.files[p] })) });
    const r0 = await G.gradeQuestion(q, unchanged);
    check(`${q.id}: unchanged project fails`, !r0.pass, r0.why);
    const ref = JSON.stringify({ files: Object.entries(q.reference).map(([p, content]) => ({ path: p, content })) });
    const r1 = await G.gradeQuestion(q, ref);
    check(`${q.id}: reference solution passes`, r1.pass, r1.why + (r1.pass ? "" : "\n" + (r1.log || r1.output || "")));
    const sneaky = JSON.stringify({ files: [{ path: "test_main.c", content: "int main(void){return 0;}" }] });
    check(`${q.id}: editing a non-editable file is refused`, !(await G.gradeQuestion(q, sneaky)).pass);
  }
  console.log(bad ? `${bad} check(s) failed` : "all checks passed");
  process.exit(bad ? 1 : 0);
})();
