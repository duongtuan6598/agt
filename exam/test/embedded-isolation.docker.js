// Run INSIDE the embedded image, exactly like the licence tool: the bank arrives on stdin, nothing is mounted
// but the public exam code. A malicious answer uses semihosting to open the bank and other files on the grader;
// it must find nothing to read, and none of its processes may outlive the question (Codex G-1, G-3).
//   docker run --rm -i --network none -v <agt>/exam:/agt/exam:ro --entrypoint node agt-box-embedded /agt/exam/test/embedded-isolation.docker.js < bank.json
const G = require("../embedded.js");
const { execSync } = require("child_process");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  const bank = JSON.parse(input);
  const q = bank.questions.filter((x) => x.kind === "fix").sort((a, b) => a.hidden.observed.length - b.hidden.observed.length)[0]; // fewest lines: the probe output stays in view
  const file = q.editable[0];
  // The attack: open host files through semihosting SYS_OPEN (0x01) and report the handles, then try to linger.
  const attack = `#include "sh.h"
int semihost(int op, const void *arg);
static int try_open(const char *name, int len) { const void *blk[3] = { name, (const void *)0, (const void *)len }; return semihost(0x01, blk); }
__attribute__((used)) void agt_probe(void)
{
    sh_print("BANK "); sh_print_int(try_open("/banks/embedded-cm3.json", 24)); sh_print("\\n");
    sh_print("STDIN "); sh_print_int(try_open("/proc/1/fd/0", 12)); sh_print("\\n");
    sh_print("ENV "); sh_print_int(try_open("/proc/1/environ", 15)); sh_print("\\n");
}
`;
  const src = q.files[file];
  const at = src.indexOf("{", src.indexOf(")")) + 1;
  const answer = JSON.stringify({ files: [{ path: file, content: attack + src.slice(0, at) + " agt_probe();" + src.slice(at) }] });
  const r = await G.gradeCode(q, answer);
  const out = r.output || "";
  const handle = (tag) => { const m = new RegExp(tag + " (-?\\d+)").exec(out); return m ? Number(m[1]) : null; };
  let bad = 0;
  const check = (name, ok, why = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${why ? " — " + why : ""}`); if (!ok) bad++; };
  check("the attack ran inside the simulator", handle("BANK") !== null, out.split("\n").filter((l) => /BANK|STDIN|ENV/.test(l)).join(" | "));
  check("the bank cannot be opened from the firmware (not on any disk)", handle("BANK") === -1);
  check("the grader's stdin (where the bank came in) cannot be opened", handle("STDIN") === -1);
  check("the grader's environment cannot be opened", handle("ENV") === -1);
  check("the attack does not pass", !r.pass, r.why);
  const left = execSync("ps -o user= | grep -c '^builder' || true").toString().trim();
  check("no sandbox process survives the question", left === "0", `left: ${left}`);
  process.exit(bad ? 1 : 0);
});
