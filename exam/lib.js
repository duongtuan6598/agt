// AGT exam system (off-chain) — Charter Article 5.
// Commit–reveal draw with a candidate seed, layer-1 auto-grading, exam record → examHash for licensing.
const { keccak256, toUtf8Bytes, concat, getBytes } = require("ethers");

// ---------- hashing & canonical JSON ----------

/** JSON with sorted keys — same data always gives the same string, hence the same hash. */
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

const hashText = (s) => keccak256(toUtf8Bytes(s));
const hashJson = (o) => hashText(canonical(o));
const lower = (s) => String(s || "").toLowerCase();

// ---------- verifiable draw ----------

/** The organiser publishes commit = keccak(secret) BEFORE the candidate picks a seed; reveals secret after the exam. */
const commitOf = (secretHex) => keccak256(secretHex);

/**
 * Draw seed = keccak(secret ‖ candidate owner ‖ examId ‖ candidate seed).
 * The organiser cannot grind the secret (it is committed before the candidate seed is known)
 * and the candidate cannot choose the secret — so nobody can pick the questions.
 */
function seedOf(secretHex, candidateOwner, examId, candidateSeed) {
  return keccak256(concat([getBytes(secretHex), toUtf8Bytes(lower(candidateOwner)), toUtf8Bytes(examId), toUtf8Bytes(candidateSeed || "")]));
}

/** Fisher–Yates over sorted ids driven by a keccak chain — deterministic for a given seed. */
function shuffle(ids, seedHex) {
  const arr = [...ids].sort();
  let h = seedHex;
  for (let i = arr.length - 1; i > 0; i--) {
    h = keccak256(h);
    const j = Number(BigInt(h) % BigInt(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Draw n questions, dropping every question written by the candidate's own owner.
 * Review exams are balanced: half correct translations, half flawed — so rejecting everything cannot pass.
 */
// The founder wrote the start-up banks but does not cook: his AIs sit in sealed boxes that cannot see the bank and
// that he cannot feed answers to, so they sit exams like anyone's. Every other author's rule stays (23 Nov 2026).
const FOUNDER = "0x778c4fdfc8825a44a24cbc2e65606b9b8fe6e769";
function draw(bank, seedHex, n, candidateOwnerIn) {
  const candidateOwner = String(candidateOwnerIn).toLowerCase() === FOUNDER ? "0x0000000000000000000000000000000000000000" : candidateOwnerIn;
  const pool = bank.questions.filter((q) => lower(q.author.owner) !== lower(candidateOwner));
  if (pool.length < n) throw new Error(`Only ${pool.length} questions available to this owner, need ${n}`);
  if (bank.kind !== "review") {
    // Banks with safety questions (security trade): every exam holds safetyPerExam of them, drawn separately.
    const k = Number(bank.safetyPerExam || 0);
    if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(k) || k < 0 || k > n) throw new Error(`bad exam size ${n} / safety questions ${k}`);
    if (new Set(pool.map((q) => q.id)).size !== pool.length) throw new Error("the bank has duplicate question ids");
    if (!k) return shuffle(pool.map((q) => q.id), seedHex).slice(0, n);
    const safe = pool.filter((q) => q.safety).map((q) => q.id);
    const work = pool.filter((q) => !q.safety).map((q) => q.id);
    if (safe.length < k || work.length < n - k) throw new Error(`Only ${safe.length} safety / ${work.length} other questions available to this owner`);
    const salt = (t) => keccak256(concat([getBytes(seedHex), toUtf8Bytes(t)]));
    return shuffle([...shuffle(safe, salt("safety")).slice(0, k), ...shuffle(work, salt("work")).slice(0, n - k)], salt("order"));
  }
  const good = pool.filter((q) => q.truth.verdict === "accept").map((q) => q.id);
  const bad = pool.filter((q) => q.truth.verdict === "reject").map((q) => q.id);
  const half = Math.floor(n / 2);
  if (good.length < half || bad.length < n - half) throw new Error(`Only ${good.length} correct / ${bad.length} flawed questions available to this owner`);
  const pick = [...shuffle(good, keccak256(concat([getBytes(seedHex), toUtf8Bytes("accept")]))).slice(0, half), ...shuffle(bad, keccak256(concat([getBytes(seedHex), toUtf8Bytes("reject")]))).slice(0, n - half)];
  return shuffle(pick, keccak256(concat([getBytes(seedHex), toUtf8Bytes("order")])));
}

/** What the candidate sees — never the truth. */
function publicQuestion(bank, q) {
  if (bank.kind === "embedded") return require("./embedded.js").publicQuestion(q);
  const glossary = q.glossary.map(([source, target]) => ({ source, target }));
  if (bank.kind === "review") return { id: q.id, source: q.source, glossary, translation: q.translation };
  return { id: q.id, source: q.source, glossary };
}

// ---------- review grading (verifier exam) ----------

/**
 * Answer = JSON string {"verdict":"accept"|"reject","flaw":"<type>","reason":"..."}.
 * Correct when the verdict matches; for a flawed translation the named flaw must be one of its true flaws.
 * A reason of at least 15 characters is required either way.
 */
function gradeReview(bank, q, answer) {
  let a = null;
  try { a = JSON.parse(answer || ""); } catch {}
  const checks = {};
  const verdict = a && String(a.verdict || "").toLowerCase();
  checks.format = { pass: !!a && (verdict === "accept" || verdict === "reject") };
  checks.verdict = { pass: verdict === q.truth.verdict };
  if (q.truth.verdict === "reject") {
    const flaw = a && String(a.flaw || "").toLowerCase();
    checks.flaw = { pass: q.truth.flaws.includes(flaw), allowed: bank.flawTypes.includes(flaw) };
  }
  checks.reason = { pass: !!a && String(a.reason || "").trim().length >= 15 };
  const falseAccept = q.truth.verdict === "reject" && verdict === "accept";
  return { id: q.id, pass: Object.values(checks).every((c) => c.pass), falseAccept, checks };
}

// ---------- layer-1 auto-grading (translation trade) ----------

const paragraphs = (s) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const stripTrail = (s) => s.replace(/[.,;:!?)]+$/, "");
const digitsOnly = (s) => s.replace(/(?<=\d)[.,](?=\d)/g, "");

/** What a translation must keep verbatim: links, code spans, numbers. */
function protectedTokens(src) {
  const urls = (src.match(/https?:\/\/\S+/g) || []).map(stripTrail);
  const code = src.match(/`[^`]+`/g) || [];
  const noCode = src.replace(/`[^`]+`/g, " ").replace(/https?:\/\/\S+/g, " ");
  const nums = noCode.match(/\d+(?:[.,:]\d+)*/g) || [];
  return { urls, code, nums };
}

function gradeTranslation(q, answer) {
  const a = (answer || "").trim();
  const src = q.source;
  const t = protectedTokens(src);
  const checks = {};

  const missingUrl = t.urls.filter((u) => !a.includes(u));
  const missingCode = t.code.filter((c) => !a.includes(c) && !a.includes(c.slice(1, -1)));
  // Compare whole numbers, not substrings: "2" must not match inside "20".
  const aNums = new Set(digitsOnly(a.replace(/`[^`]+`/g, " ")).match(/\d+(?::\d+)*/g) || []);
  const missingNum = t.nums.filter((n) => !aNums.has(digitsOnly(n)));
  checks.preserved = { pass: !missingUrl.length && !missingCode.length && !missingNum.length, missing: [...missingUrl, ...missingCode, ...missingNum] };

  const lc = a.toLowerCase();
  const missingTerm = q.glossary.filter(([, target]) => !lc.includes(target.toLowerCase())).map(([s, target]) => `${s} → ${target}`);
  checks.glossary = { pass: !missingTerm.length, missing: missingTerm };

  const ps = paragraphs(src).length, pa = paragraphs(a).length;
  checks.paragraphs = { pass: ps === pa, source: ps, answer: pa };

  const ratio = a.length / src.length;
  checks.length = { pass: ratio >= 0.8 && ratio <= 2.0, ratio: Math.round(ratio * 100) / 100 };

  // Untranslated: share of the source's English words (≥4 letters, outside code/links) left verbatim.
  const plain = (s) => s.replace(/`[^`]+`/g, " ").replace(/https?:\/\/\S+/g, " ");
  const words = [...new Set((plain(src).match(/[A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase()))];
  const left = words.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(plain(a)));
  const leftRatio = words.length ? left.length / words.length : 0;
  checks.translated = { pass: leftRatio < 0.25, leftover: Math.round(leftRatio * 100) / 100 };

  return { id: q.id, pass: Object.values(checks).every((c) => c.pass), checks };
}

// ---------- whole exam & record ----------

/**
 * Grade an exam. Passing layer 1 is not a licence yet: the record moves to semantic review
 * (by licensed verifier AIs, or by the founder during genesis).
 */
function gradeExam(bank, drawn, answers) {
  // Embedded answers are graded by BUILDING and RUNNING them in the embedded box image (exam/embedded.js),
  // which the exam service cannot do: the record waits for that grading (licence process / Council boxes).
  if (bank.kind === "embedded") {
    return { results: drawn.map((id) => ({ id, pass: null, why: "graded by running it in the embedded box image" })), passed: 0, total: drawn.length, falseAccepts: 0, status: "awaiting-grading" };
  }
  const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));
  const review = bank.kind === "review";
  const results = drawn.map((id) => (review ? gradeReview(bank, byId[id], answers[id]) : gradeTranslation(byId[id], answers[id])));
  const passed = results.filter((r) => r.pass).length;
  const falseAccepts = results.filter((r) => r.falseAccept).length;
  // A verifier that lets even one flawed piece of work through cannot be trusted with the Work door.
  const ok = passed >= bank.passMark && (!review || falseAccepts <= (bank.maxFalseAccepts || 0));
  // Review exams are graded against known truth, so passing is final; translation exams still need semantic review.
  const status = !ok ? "failed" : review ? "passed" : "awaiting-review";
  return { results, passed, total: drawn.length, falseAccepts, status };
}

/** Full exam record → examHash, written into the on-chain licence. */
function examRecord({ bank, examId, candidateSeed, candidate, commit, secret, startedAt, finishedAt, drawn, answers, grade, signature }) {
  const record = {
    version: 1,
    trade: bank.trade,
    bankHash: hashJson(bank),
    examId,
    candidateSeed,
    candidate, // { name, owner, agent }
    commit,
    secret,
    startedAt,
    finishedAt,
    questions: drawn,
    answers: Object.fromEntries(drawn.map((id) => [id, hashText(answers[id] || "")])),
    result: { passed: grade.passed, total: grade.total, falseAccepts: grade.falseAccepts, status: grade.status },
    signature: signature || null,
  };
  return { record, examHash: hashJson(record) };
}

/** Anyone can re-check: the secret matches the commit, and the draw is exactly the recorded one. */
function verifyDraw(bank, record) {
  if (commitOf(record.secret) !== record.commit) return false;
  const seed = seedOf(record.secret, record.candidate.owner, record.examId, record.candidateSeed);
  const again = draw(bank, seed, record.questions.length, record.candidate.owner);
  return canonical(again) === canonical(record.questions);
}

/** The message the candidate's AI key signs when submitting — binds the answers to that key. */
const submitMessage = (examId, answers) => `AGT exam submission\nexam: ${examId}\nanswers: ${hashJson(answers)}`;

module.exports = { canonical, hashText, hashJson, commitOf, seedOf, draw, publicQuestion, protectedTokens, gradeTranslation, gradeReview, gradeExam, examRecord, verifyDraw, submitMessage };
