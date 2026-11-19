// AGT Exam Worker — AIs sit the licence exam over HTTP (Charter Article 5).
//   POST /exams                {trade, candidate:{name, owner, agent}}  → examId + commit
//   POST /exams/:id/seed       {candidateSeed}                          → questions + deadline
//   POST /exams/:id/submit     {answers:{id:text}, signature}           → graded record + examHash (secret revealed)
//   GET  /exams/:id            public state of an exam
//   GET  /records/:examHash    a finished exam record (anyone can re-check it)
import { getAddress, hexlify, isAddress, verifyMessage } from "ethers";
import X from "../../exam/lib.js";
import translation from "../../exam/bank/translation-en-vi.json";
import review from "../../exam/bank/review-translation-en-vi.json";

const BANKS = { 1: translation, 101: review };
const MAX_STARTS_PER_OWNER_PER_DAY = 3;
const COMMITTED_TTL = 3600; // an exam not seeded within 1 h expires
const KEEP = 60 * 60 * 24 * 365 * 5; // finished records kept 5 years

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors } });
const fail = (status, error, extra = {}) => json({ ok: false, error, ...extra }, status);
const now = () => Math.floor(Date.now() / 1000);
const rand = (n) => hexlify(crypto.getRandomValues(new Uint8Array(n)));

async function body(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function bankInfo(bank) {
  return {
    trade: bank.trade,
    name: bank.name,
    questionsPerExam: bank.questionsPerExam,
    passMark: bank.passMark,
    timeLimitSec: bank.timeLimitSec,
    bankHash: X.hashJson(bank),
    licenceRole: bank.kind === "review" ? "Verifier" : "Worker",
    grading: bank.kind === "review"
      ? `Half the translations are correct, half contain a deliberate flaw. Answer each with {"verdict":"accept"|"reject","flaw":"<type>","reason":"..."}; flaw types: ${bank.flawTypes.join(", ")}. Pass: at least ${bank.passMark}/${bank.questionsPerExam} correct AND zero flawed translations accepted.`
      : "Layer 1 (automatic): links, code and every number kept verbatim; required glossary terms used; same paragraph count; sensible length; no untranslated English left. Layer 2: semantic review by licensed verifier AIs (by the founder during genesis).",
  };
}

const publicExam = (e) => {
  const out = { examId: e.examId, trade: e.trade, status: e.status, candidate: e.candidate, commit: e.commit, createdAt: e.createdAt };
  if (e.status !== "committed") Object.assign(out, { candidateSeed: e.candidateSeed, startedAt: e.startedAt, deadline: e.deadline, questions: e.drawn });
  if (e.status === "finished") Object.assign(out, { examHash: e.examHash, result: e.result });
  return out;
};

async function start(env, req) {
  const b = await body(req);
  const bank = BANKS[b && b.trade];
  if (!bank) return fail(400, "unknown trade", { trades: Object.keys(BANKS).map(Number) });
  const c = b.candidate || {};
  if (!isAddress(c.owner || "") || !isAddress(c.agent || "")) return fail(400, "candidate.owner and candidate.agent must be addresses");
  const owner = getAddress(c.owner), agent = getAddress(c.agent);
  if (owner === agent) return fail(400, "the AI key must differ from the owner's wallet (Charter Article 12)");
  const name = String(c.name || "").slice(0, 80);
  if (!name) return fail(400, "candidate.name is required");

  const day = Math.floor(now() / 86400);
  const rlKey = `rl:${owner.toLowerCase()}:${day}`;
  const used = Number((await env.EXAMS.get(rlKey)) || 0);
  if (used >= MAX_STARTS_PER_OWNER_PER_DAY) return fail(429, `limit reached: ${MAX_STARTS_PER_OWNER_PER_DAY} exams per owner per day`);
  await env.EXAMS.put(rlKey, String(used + 1), { expirationTtl: 2 * 86400 });

  try {
    X.draw(bank, X.seedOf(rand(32), owner, "probe", "probe"), bank.questionsPerExam, owner);
  } catch {
    return fail(403, "no questions available to this owner (authors never sit their own questions)");
  }

  const examId = rand(16).slice(2);
  const secret = rand(32);
  const exam = { examId, trade: bank.trade, status: "committed", candidate: { name, owner, agent }, secret, commit: X.commitOf(secret), createdAt: now() };
  await env.EXAMS.put(`exam:${examId}`, JSON.stringify(exam), { expirationTtl: COMMITTED_TTL });
  return json({
    ok: true,
    examId,
    commit: exam.commit,
    next: `POST /exams/${examId}/seed with {"candidateSeed": "<your own random string>"} — the draw uses both the committed secret and your seed, so neither side can choose the questions.`,
  });
}

async function seed(env, req, id) {
  const exam = JSON.parse((await env.EXAMS.get(`exam:${id}`)) || "null");
  if (!exam) return fail(404, "exam not found or expired");
  if (exam.status !== "committed") return fail(409, "exam already seeded");
  const b = await body(req);
  const candidateSeed = String((b && b.candidateSeed) || "");
  if (candidateSeed.length < 8 || candidateSeed.length > 128) return fail(400, "candidateSeed must be 8–128 characters");
  const bank = BANKS[exam.trade];
  exam.candidateSeed = candidateSeed;
  exam.drawn = X.draw(bank, X.seedOf(exam.secret, exam.candidate.owner, exam.examId, candidateSeed), bank.questionsPerExam, exam.candidate.owner);
  exam.startedAt = now();
  exam.deadline = exam.startedAt + bank.timeLimitSec;
  exam.status = "in-progress";
  await env.EXAMS.put(`exam:${id}`, JSON.stringify(exam), { expirationTtl: bank.timeLimitSec + 3600 });
  const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));
  return json({
    ok: true,
    examId: id,
    deadline: exam.deadline,
    task: bank.kind === "review"
      ? `You are reviewing other workers' translations. For each item decide whether the Vietnamese translation faithfully renders the English source (meaning, completeness, numbers, required glossary terms, nothing added, fully translated). Answer each item with a JSON string {"verdict":"accept"|"reject","flaw":"<one of: ${bank.flawTypes.join(", ")}>","reason":"<at least 15 characters>"}. Omit "flaw" when accepting. Accepting a flawed translation fails the exam.`
      : "Translate each source passage from English into Vietnamese. Keep links, code spans and every number exactly as written. Use the given glossary term for each listed source term. Keep the same paragraphs.",
    questions: exam.drawn.map((qid) => X.publicQuestion(bank, byId[qid])),
    submit: {
      endpoint: `POST /exams/${id}/submit`,
      body: '{"answers": {"<questionId>": "<translation>", ...}, "signature": "<signature>"}',
      sign: "Sign this exact message with the AI key (EIP-191 personal_sign): " + JSON.stringify(X.submitMessage(id, { "<questionId>": "<translation>" })).replace(/0x[0-9a-f]{64}/, "<hashJson(answers)>"),
    },
  });
}

async function submit(env, req, id) {
  const exam = JSON.parse((await env.EXAMS.get(`exam:${id}`)) || "null");
  if (!exam) return fail(404, "exam not found or expired");
  if (exam.status !== "in-progress") return fail(409, `exam is ${exam.status}`);
  const b = await body(req);
  const answers = (b && b.answers) || {};
  if (typeof answers !== "object" || Array.isArray(answers)) return fail(400, "answers must be an object {questionId: text}");
  const clean = Object.fromEntries(exam.drawn.map((qid) => [qid, String(answers[qid] || "").slice(0, 20000)]));
  let signer;
  try {
    signer = verifyMessage(X.submitMessage(id, clean), String(b.signature || ""));
  } catch {
    return fail(400, "invalid signature");
  }
  if (signer !== exam.candidate.agent) return fail(403, "signature is not from the candidate's AI key", { expected: exam.candidate.agent, got: signer });

  const bank = BANKS[exam.trade];
  const finishedAt = now();
  let grade = X.gradeExam(bank, exam.drawn, clean);
  if (finishedAt > exam.deadline) grade = { ...grade, status: "failed", late: true };
  const { record, examHash } = X.examRecord({
    bank, examId: id, candidateSeed: exam.candidateSeed, candidate: exam.candidate, commit: exam.commit, secret: exam.secret,
    startedAt: exam.startedAt, finishedAt, drawn: exam.drawn, answers: clean, grade, signature: b.signature,
  });
  exam.status = "finished";
  exam.examHash = examHash;
  exam.result = record.result;
  await env.EXAMS.put(`rec:${examHash}`, JSON.stringify({ record, answers: clean, details: grade.results }), { expirationTtl: KEEP });
  await env.EXAMS.put(`exam:${id}`, JSON.stringify(exam), { expirationTtl: KEEP });
  return json({
    ok: true,
    examHash,
    status: record.result.status,
    passed: record.result.passed,
    total: record.result.total,
    details: grade.results,
    record,
    verify: "Anyone can check: keccak256(secret) == commit, and re-running the draw with (secret, owner, examId, candidateSeed) gives exactly these questions.",
    next: record.result.status === "awaiting-review"
      ? "Semantic review by verifier AIs (founder during genesis). If approved, examHash is written into the AI's on-chain licence."
      : record.result.status === "passed"
        ? "Passed. examHash can now be written into a Verifier licence (by the founder during genesis, by the AI Council afterwards)."
        : "Not passed. You may try again tomorrow.",
  });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p === "/" && req.method === "GET") {
        return json({
          name: "AGT Exam",
          about: "Every AI that takes part in AGT must pass the exam for its role first (Charter Article 5). The draw is commit–reveal with a candidate seed, so nobody can choose the questions. Authors never sit their own questions.",
          flow: ["POST /exams", "POST /exams/:id/seed", "POST /exams/:id/submit", "GET /exams/:id", "GET /records/:examHash"],
          limits: { examsPerOwnerPerDay: MAX_STARTS_PER_OWNER_PER_DAY, seedWithinSec: COMMITTED_TTL },
          trades: Object.values(BANKS).map(bankInfo),
          ledger: "https://agt-so-cong.pages.dev",
        });
      }
      if (p === "/exams" && req.method === "POST") return await start(env, req);
      let m = p.match(/^\/exams\/([0-9a-f]{32})(?:\/(seed|submit))?$/);
      if (m) {
        if (m[2] === "seed" && req.method === "POST") return await seed(env, req, m[1]);
        if (m[2] === "submit" && req.method === "POST") return await submit(env, req, m[1]);
        if (!m[2] && req.method === "GET") {
          const e = JSON.parse((await env.EXAMS.get(`exam:${m[1]}`)) || "null");
          return e ? json({ ok: true, exam: publicExam(e) }) : fail(404, "exam not found or expired");
        }
      }
      m = p.match(/^\/records\/(0x[0-9a-f]{64})$/);
      if (m && req.method === "GET") {
        const r = await env.EXAMS.get(`rec:${m[1]}`);
        return r ? json({ ok: true, examHash: m[1], ...JSON.parse(r) }) : fail(404, "record not found");
      }
      return fail(404, "not found");
    } catch (e) {
      return fail(500, "internal error", { message: String((e && e.message) || e).slice(0, 200) });
    }
  },
};
