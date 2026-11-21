// The exam grader's supervisor (THIET-KE-NGHE-CHAM-THI.md). Runs as root in a sealed box from the approved GRADER
// image. For each exam it is drawn for: a fresh one-job key, an attested manifest, the drawn questions sealed to that
// key by the bank's custodian, grading in the sandbox, a signed result. One exam at a time; every sandbox process
// is killed between exams.
//
// Fail closed (testnet finding T-1): before every exam the sandbox user must be unable to reach a TEE socket — a
// candidate's code that could reach it could obtain a genuine attestation for a manifest of its own.
//
// io (the exam service, or a test double):
//   nextJob() → { job, examHash, drawn, packageHash, answersHash, salt, answers } | null   (the exam's commitments)
//   postJob({ manifest, evidence, signature })     the custodian verifies the grader, then seals the package
//   getPackage(nonce) → { box } | null
//   postResult(nonce, { result, signature })
const http = require("http");
const fs = require("fs");
const G = require("./grader.js");
const T = require("../verify.js");

const SOCK = "/run/container_launcher/teeserver.sock";
const log = (...a) => console.log(new Date().toISOString(), "[grader]", ...a);

function launcherToken(nonce) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCK)) return reject(new Error(`no Confidential Space launcher (${SOCK})`));
    const body = JSON.stringify({ audience: T.AUDIENCE, token_type: "OIDC", nonces: [nonce] });
    const req = http.request({ socketPath: SOCK, path: "/v1/token", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(t.trim()) : reject(new Error(`launcher ${res.statusCode}: ${t}`))));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/// Grade one exam, start to end. Returns the signed result, or throws (nothing is signed on any failure).
async function gradeOne({ io, attest, grade, imageDigest, isolationProbe, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitSec = 600, pollSec = 5 }) {
  const iso = await isolationProbe();
  if (!iso.ok) throw new Error(`refusing to grade: ${iso.failures.join("; ")}`);
  const ex = await io.nextJob();
  if (!ex) return null;
  const job = G.newGradingJob({ job: ex.job, examHash: ex.examHash, drawn: ex.drawn, packageHash: ex.packageHash, answersHash: ex.answersHash, imageDigest });
  const evidence = await attest(T.nonceOf(job.manifest));
  await io.postJob({ manifest: job.manifest, evidence, signature: await G.signJob(job) });
  let sealed = null;
  for (let waited = 0; !sealed && waited < waitSec; waited += pollSec) {
    sealed = await io.getPackage(job.manifest.nonce);
    if (!sealed) await sleep(pollSec * 1000);
  }
  if (!sealed) throw new Error(`no package for exam ${ex.examHash} in time`);
  const out = await G.gradeJob({ job, sealed, answers: ex.answers, salt: ex.salt, grade });
  await io.postResult(job.manifest.nonce, out);
  log(`exam ${ex.examHash.slice(0, 12)}…: ${out.result.passed}/${out.result.total} — signed`);
  return out;
}

module.exports = { gradeOne, launcherToken };

if (require.main === module) {
  const isolation = require("../embedded/isolation.js");
  isolation.lockDown(log);
  const E = require("../../exam/embedded.js");
  const tools = require("../embedded/tools.js");
  // The exam service's grading endpoints are step 2 of THIET-KE-NGHE-CHAM-THI.md (with the ExamGrading contract).
  const base = process.env.AGT_EXAM_URL || "https://agt-exam.agtcoin.workers.dev";
  const j = async (path, opts) => { const r = await fetch(base + path, opts); if (r.status === 404) return null; if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); };
  const post = (path, body) => j(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const io = {
    nextJob: () => j("/grading/next"),
    postJob: (x) => post("/grading/jobs", x),
    getPackage: (nonce) => j(`/grading/${nonce}/package`),
    postResult: (nonce, x) => post(`/grading/${nonce}/result`, x),
  };
  (async () => {
    // The manifest must name this box's own image, which only the attestation knows: read it from a first token
    // (signed by the attestation service) before any job.
    const first = await launcherToken(require("crypto").randomBytes(32).toString("hex"));
    const claims = JSON.parse(Buffer.from(first.split(".")[1], "base64url"));
    const imageDigest = claims.submods && claims.submods.container && claims.submods.container.image_digest;
    if (!imageDigest) { log("FAILED: the attestation names no image"); process.exit(1); }
    log(`grader ready · image ${imageDigest}`);
    for (;;) {
      try {
        const out = await gradeOne({ io, attest: async (nonce) => ({ token: await launcherToken(nonce) }), grade: (pkg, drawn, answers) => E.gradeExam(pkg, drawn, answers, { tools }), imageDigest, isolationProbe: () => isolation.probe({ metadata: false }) });
        if (!out) await new Promise((r) => setTimeout(r, 30000));
      } catch (e) {
        log("FAILED:", e.message);
        if (/refusing to grade/.test(e.message)) process.exit(1); // never run candidate code without isolation
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  })();
}
