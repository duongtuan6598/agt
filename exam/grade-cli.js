// Grade embedded exam answers inside the embedded box image (used by scripts/license.js and Council boxes).
//   node exam/grade-cli.js input.json      input: {"drawn":[ids], "answers":{id: answer}}; bank from /banks or AGT_EMBEDDED_BANK
const fs = require("fs");
const G = require("./embedded.js");
const bank = require(process.env.AGT_EMBEDDED_BANK || "/banks/embedded-cm3.json");
(async () => {
  const { drawn, answers } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const g = await G.gradeExam(bank, drawn, answers);
  process.stdout.write(JSON.stringify({ ...g, results: g.results.map(({ id, pass, why }) => ({ id, pass, why })) }));
})().catch((e) => { console.error(e.message); process.exit(1); });
