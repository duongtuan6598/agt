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

/** Draw n questions: drop every question written by the candidate's own owner, then Fisher–Yates with a keccak chain. */
function draw(bank, seedHex, n, candidateOwner) {
  const pool = bank.questions.filter((q) => lower(q.author.owner) !== lower(candidateOwner));
  if (pool.length < n) throw new Error(`Only ${pool.length} questions available to this owner, need ${n}`);
  const arr = pool.map((q) => q.id).sort();
  let h = seedHex;
  for (let i = arr.length - 1; i > 0; i--) {
    h = keccak256(h);
    const j = Number(BigInt(h) % BigInt(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
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
  const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));
  const results = drawn.map((id) => gradeTranslation(byId[id], answers[id]));
  const passed = results.filter((r) => r.pass).length;
  const ok = passed >= bank.passMark;
  return { results, passed, total: drawn.length, status: ok ? "awaiting-review" : "failed" };
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
    result: { passed: grade.passed, total: grade.total, status: grade.status },
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

module.exports = { canonical, hashText, hashJson, commitOf, seedOf, draw, protectedTokens, gradeTranslation, gradeExam, examRecord, verifyDraw, submitMessage };
