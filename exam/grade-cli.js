// Grade embedded exam answers inside the embedded box image (used by scripts/license.js and Council boxes).
//   echo '{"bank":{…},"drawn":[ids],"answers":{id: answer}}' | node exam/grade-cli.js
// The bank arrives on STDIN and stays in this (root) process's memory: it is never written to a file in the
// container, so the candidate's firmware — which can open host files through semihosting as the sandbox
// user — has nothing to read (Codex G-1). The expected observations exist nowhere it can reach.
const G = require("./embedded.js");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    const { bank, drawn, answers } = JSON.parse(input);
    input = "";
    if (!bank || bank.kind !== "embedded") throw new Error("expected an embedded bank on stdin");
    const g = await G.gradeExam(bank, drawn, answers);
    process.stdout.write(JSON.stringify({ ...g, results: g.results.map(({ id, pass, why }) => ({ id, pass, why })) }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
});
