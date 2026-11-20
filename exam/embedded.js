// Embedded trade exam (THIET-KE-NGHE-NHUNG.md §7): expert-level, practical, graded by RUNNING the answer.
// The bank (private, agt-banks/embedded-cm3.json) holds each question's project, its hidden tests and a reference
// solution. The candidate sees only the project and the task. Grading needs the embedded box image (toolchain +
// QEMU): it runs in the licence process, and after genesis in the Council AIs' sealed boxes — never on the
// exam service. Kinds:
//   fix     — a real-world defect; the hidden tests must pass on the fixed code
//   driver  — implement a peripheral driver from a register map; hidden tests drive the simulated hardware
//   budget  — make the firmware fit a flash/RAM budget with identical behaviour
//   review  — find the seeded defects (file, line, kind); every one must be found, at most one false alarm
// Answers: code kinds → JSON {"files":[{"path","content"}]} (only paths in `editable`); review → JSON
// {"defects":[{"file","line","kind"}]}.
const fs = require("fs");
const os = require("os");
const path = require("path");

const KINDS = ["fix", "driver", "budget", "review"];
const DEFECT_KINDS = ["overflow", "off-by-one", "volatile", "race", "uninitialized", "integer-overflow", "null", "leak", "wraparound", "logic"];

/** What the candidate sees — never the hidden tests, the truth or the reference. */
function publicQuestion(q) {
  const out = { id: q.id, kind: q.kind, title: q.title, task: q.task, target: q.target, files: q.files, editable: q.editable || [] };
  if (q.kind === "review") out.defectKinds = DEFECT_KINDS;
  if (q.hidden && q.hidden.flashLimit) out.flashLimit = q.hidden.flashLimit;
  return out;
}

function parseAnswer(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

/** Grade a review answer against the seeded defects (no toolchain needed). */
function gradeReview(q, answer) {
  const a = parseAnswer(answer);
  if (!a || !Array.isArray(a.defects)) return { pass: false, why: "answer is not {defects:[…]}" };
  const truth = q.truth.defects;
  if (a.defects.length > 20) return { pass: false, why: "more than 20 defects claimed" }; // every claim counts (Codex G-4)
  const claimed = a.defects.filter((d) => d && typeof d.file === "string" && Number.isInteger(d.line) && typeof d.kind === "string");
  if (claimed.length !== a.defects.length) return { pass: false, why: "malformed defect entries" };
  const used = new Set();
  let found = 0;
  for (const t of truth) {
    const i = claimed.findIndex((d, k) => !used.has(k) && d.file === t.file && Math.abs(d.line - t.line) <= 1 && d.kind === t.kind);
    if (i >= 0) { used.add(i); found++; }
  }
  const falseAlarms = claimed.length - used.size;
  const pass = found === truth.length && falseAlarms <= 1;
  return { pass, found, of: truth.length, falseAlarms, why: pass ? "all defects found" : `found ${found}/${truth.length}, ${falseAlarms} false alarm(s)` };
}

/** Write a project tree safely (no absolute paths, no "..", no symlinks followed). */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`bad path ${rel}`);
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

/** Observation lines the hidden tests printed, in order ("OBS <tag> <hex>"). */
const observations = (out) => out.split("\n").map((l) => l.trim()).filter((l) => /^OBS \S+ 0x[0-9a-f]{8}$/.test(l));

/** Grade a code answer by building it with the hidden tests and running it in QEMU (inside the embedded image).
 *  The hidden tests print OBSERVED values only; the expected values are the bank's recording of the reference
 *  run and never enter the firmware, so an answer cannot fake a pass by printing a marker. A fresh nonce in the
 *  END line proves the hidden harness itself ran to its end. `record: true` returns the observations instead. */
async function gradeCode(q, answer, { tools = require("../tee/embedded/tools.js"), workRoot = "/work/exam", chown = true, record = false } = {}) {
  const a = parseAnswer(answer);
  if (!a || !Array.isArray(a.files)) return { pass: false, why: "answer is not {files:[…]}" };
  const allowed = new Set(q.editable || []);
  const edits = {};
  for (const f of a.files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") return { pass: false, why: "bad file entry" };
    if (!allowed.has(f.path)) return { pass: false, why: `${f.path} may not be changed in this question` };
    if (f.content.length > 200000) return { pass: false, why: `${f.path} is too large` };
    edits[f.path] = f.content;
  }
  fs.mkdirSync(workRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(workRoot, q.id + "-"));
  try {
    writeTree(dir, q.files);
    writeTree(dir, edits);
    const nonce = require("crypto").randomBytes(12).toString("hex");
    const hidden = Object.fromEntries(Object.entries(q.hidden.files || {}).map(([k, v]) => [k, v.split("__AGT_NONCE__").join(nonce)]));
    writeTree(dir, hidden); // hidden tests last: an answer cannot overwrite them
    if (chown && process.getuid && process.getuid() === 0) require("child_process").execFileSync("chown", ["-R", "1500:1500", dir]);
    const b = await tools.build({ dir, cmd: q.hidden.build, artifact: q.artifact || "firmware.elf", timeoutMs: 120000 });
    if (!b.ok) return { pass: false, why: "build failed", log: b.log.slice(-1500) };
    const elf = path.join(dir, q.artifact || "firmware.elf");
    if (q.hidden.flashLimit || q.hidden.ramLimit) {
      const s = await tools.size({ elf, flashLimit: q.hidden.flashLimit, ramLimit: q.hidden.ramLimit });
      if (!s.ok) return { pass: false, why: `over budget: flash ${s.flash} B (limit ${q.hidden.flashLimit}), RAM ${s.ram} B`, size: s };
    }
    // Hidden-test observations come only from semihosting; UART expectations only from the UART capture (G-2).
    const r = await tools.simulate({ elf, target: q.target, expect: q.hidden.serial ? ["END " + nonce] : [...(q.hidden.expect || []), "END " + nonce], expectUart: q.hidden.serial ? q.hidden.expect || [] : [], timeoutMs: 20000 });
    const seen = observations(r.output);
    if (record) return { pass: r.ok, observed: seen, output: r.output.slice(-1500) };
    if (!r.ok) return { pass: false, why: `hidden tests did not complete (missing: ${r.missing.join(" | ") || "clean exit"})`, output: r.output.slice(-1500) };
    const want = q.hidden.observed;
    if (!Array.isArray(want) || !want.length) return { pass: false, why: "this question has no recorded observations (bank not finalised)" };
    const bad = want.findIndex((w, i) => seen[i] !== w);
    const ok = bad < 0 && seen.length === want.length;
    return { pass: ok, why: ok ? "hidden tests passed" : `wrong value at observation ${bad < 0 ? want.length + 1 : bad + 1} of ${want.length}`, output: r.output.slice(-1500) };
  } finally {
    // Kill every process of the sandbox user, detached ones too (setsid escapes a process group — Codex G-3),
    // so nothing from this answer survives into the next question.
    if (chown && process.getuid && process.getuid() === 0) await tools.run("/bin/sh", ["-c", "kill -9 -1"], { cwd: "/", timeoutMs: 5000 }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function gradeQuestion(q, answer, opts) {
  if (!KINDS.includes(q.kind)) return { pass: false, why: `unknown kind ${q.kind}` };
  return q.kind === "review" ? gradeReview(q, answer) : gradeCode(q, answer, opts);
}

/** Grade a whole embedded exam (same shape as exam/lib.js gradeExam). */
async function gradeExam(bank, drawn, answers, opts) {
  const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));
  const results = [];
  for (const id of drawn) results.push({ id, ...(await gradeQuestion(byId[id], answers[id], opts)) });
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: drawn.length, falseAccepts: 0, status: passed >= bank.passMark ? "passed" : "failed" };
}

module.exports = { observations, publicQuestion, gradeReview, gradeCode, gradeQuestion, gradeExam, parseAnswer, KINDS, DEFECT_KINDS, tmp: os.tmpdir };
