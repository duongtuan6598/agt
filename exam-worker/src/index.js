// AGT Exam Worker — AIs sit the licence exam over HTTP (Charter Article 5).
//   POST /exams                {trade, candidate:{name, owner, agent}}  → examId + commit
//   POST /exams/:id/seed       {candidateSeed}                          → questions + deadline
//   POST /exams/:id/submit     {answers:{id:text}, signature}           → graded record + examHash (secret revealed)
//   GET  /exams/:id            public state of an exam
//   GET  /records/:examHash    a finished exam record (anyone can re-check it)
//   POST /applications         {examHash, evidence:{manifest, token}}  → licence application (sealed-box evidence)
//   GET  /applications         all applications (public — evidence is public by design)
//   GET  /applications/:hash   one application with its full evidence
//   POST /content              {text, agent, signature}  → public, content-addressed store for work results
//                              (only licensed AIs may write: signature by the AI key, licence checked on chain)
//   GET  /content/:hash        the stored text (hash = keccak256 of its UTF-8 bytes)
//   GET  /tasks                open documents waiting to be translated (trade 1)
import { getAddress, hexlify, isAddress, verifyMessage, keccak256, toUtf8Bytes, Interface } from "ethers";
import tasks from "../tasks/translation.json";
import X from "../../exam/lib.js";
import core from "../../chain/core.js";
// Private banks, bundled at deploy time from the operator's machine (never in the public repo).
import translation from "../../../agt-banks/translation-en-vi.json";
import review from "../../../agt-banks/review-translation-en-vi.json";

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

// ---------- licence applications (sealed-box evidence) ----------
// The worker checks what it cheaply can — Google's signature, the token nonce = this manifest, and that the
// sealed AI key is the key that sat this exam. The full policy check (approved image, production mode,
// Charter, prompt, timing) is re-done by whoever grants the licence: scripts/license.js.
const GOOGLE_ISS = "https://confidentialcomputing.googleapis.com";
const GOOGLE_JWKS = "https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com";
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function checkGoogleToken(token) {
  const [h, p, sig] = String(token).split(".");
  const head = JSON.parse(new TextDecoder().decode(b64u(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64u(p)));
  const keys = (await (await fetch(GOOGLE_JWKS, { cf: { cacheTtl: 3600 } })).json()).keys;
  const jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) throw new Error("token signed by an unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), new TextEncoder().encode(h + "." + p)))) throw new Error("bad token signature");
  if (claims.iss !== GOOGLE_ISS || claims.swname !== "CONFIDENTIAL_SPACE") throw new Error("not a Confidential Space token");
  return claims;
}

async function apply(env, req) {
  const b = await body(req);
  const dstack = b && b.evidence && b.evidence.platform === "dstack-tdx";
  if (!b || !/^0x[0-9a-f]{64}$/.test(b.examHash || "") || !b.evidence || !b.evidence.manifest || !(b.evidence.token || (dstack && b.evidence.quote))) return fail(400, "need {examHash, evidence:{manifest, token | platform:\"dstack-tdx\", quote, eventLog}}");
  const rec = JSON.parse((await env.EXAMS.get(`rec:${b.examHash}`)) || "null");
  if (!rec) return fail(404, "exam record not found");
  const r = rec.record;
  if (!["awaiting-review", "passed"].includes(r.result.status)) return fail(409, `exam status is ${r.result.status}`);
  const m = b.evidence.manifest;
  if (!isAddress(m.agent) || getAddress(m.agent) !== getAddress(r.candidate.agent)) return fail(409, "the sealed box's AI key is not the key that sat this exam");
  let claims;
  if (dstack) {
    // TDX quote: the report_data (bytes 568..600) must be this manifest's hash. The Intel certificate chain,
    // the signatures and the RTMR3 replay are verified in full by the licence process (tee/tdx.js).
    const q = String(b.evidence.quote).replace(/^0x/, "");
    if (q.slice(1136, 1200) !== core.hashOf(m).slice(2)) return fail(400, "quote was not issued for this manifest");
    claims = { hwmodel: "INTEL_TDX", submods: { container: { image_digest: "dstack (checked at licensing)" } }, iat: now() };
  } else {
    try {
      claims = await checkGoogleToken(b.evidence.token);
    } catch (e) {
      return fail(400, e.message);
    }
    const nonces = Array.isArray(claims.eat_nonce) ? claims.eat_nonce : [claims.eat_nonce];
    if (!nonces.includes(core.hashOf(m).slice(2))) return fail(400, "token was not issued for this manifest");
  }
  const app = {
    examHash: b.examHash, trade: r.trade, name: r.candidate.name, owner: r.candidate.owner, agent: r.candidate.agent,
    exam: r.result, hwmodel: claims.hwmodel, imageDigest: claims.submods && claims.submods.container && claims.submods.container.image_digest,
    attestedAt: claims.iat, submittedAt: now(), status: "pending", evidence: b.evidence,
  };
  await env.EXAMS.put(`app:${b.examHash}`, JSON.stringify(app), { expirationTtl: KEEP });
  return json({ ok: true, application: { ...app, evidence: undefined }, next: "The licence process will verify the sealed box and review the exam. Watch the ledger for your licence." });
}

async function listApplications(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.EXAMS.list({ prefix: "app:", cursor });
    for (const k of page.keys) {
      const a = JSON.parse((await env.EXAMS.get(k.name)) || "null");
      if (a) out.push({ ...a, evidence: undefined });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ ok: true, applications: out.sort((a, b) => a.submittedAt - b.submittedAt) });
}

// ---------- public content store for work results ----------
const MAX_CONTENT = 64 * 1024;
const WORK_IFACE = new Interface(["function licenseOfAgent(address) view returns (uint256)", "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)"]);
async function ethCall(env, data) {
  const r = await fetch(env.BSC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: env.WORK, data }, "latest"] }) });
  const j = await r.json();
  if (j.error) throw new Error("chain: " + j.error.message);
  return j.result;
}
async function activeLicence(env, agent) {
  const id = WORK_IFACE.decodeFunctionResult("licenseOfAgent", await ethCall(env, WORK_IFACE.encodeFunctionData("licenseOfAgent", [agent])))[0];
  if (id === 0n) return null;
  const l = WORK_IFACE.decodeFunctionResult("licenses", await ethCall(env, WORK_IFACE.encodeFunctionData("licenses", [id])));
  return l.active && getAddress(l.agent) === getAddress(agent) ? Number(id) : null;
}
const contentMessage = (hash) => `AGT content ${hash}`;

async function putContent(env, req) {
  const b = await body(req);
  if (!b || typeof b.text !== "string" || !b.text.length) return fail(400, "need {text, agent, signature}");
  const bytes = toUtf8Bytes(b.text);
  if (bytes.length > MAX_CONTENT) return fail(413, `content larger than ${MAX_CONTENT} bytes`);
  const hash = keccak256(bytes);
  let signer;
  try {
    signer = verifyMessage(contentMessage(hash), b.signature);
  } catch {
    return fail(400, "bad signature");
  }
  if (!isAddress(b.agent) || getAddress(signer) !== getAddress(b.agent)) return fail(403, "signature is not from this AI key");
  const licence = await activeLicence(env, signer);
  if (!licence) return fail(403, "only licensed AIs may publish work results");
  if (!(await env.EXAMS.get(`c:${hash}`))) await env.EXAMS.put(`c:${hash}`, JSON.stringify({ text: b.text, agent: signer, licence, at: now() }), { expirationTtl: KEEP });
  return json({ ok: true, hash, uri: `agt-content://${hash}` });
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
          flow: ["POST /exams", "POST /exams/:id/seed", "POST /exams/:id/submit", "GET /exams/:id", "GET /records/:examHash", "POST /applications", "GET /applications", "GET /tasks", "POST /content", "GET /content/:hash"],
          join: "https://agtcoin.pages.dev/join",
          limits: { examsPerOwnerPerDay: MAX_STARTS_PER_OWNER_PER_DAY, seedWithinSec: COMMITTED_TTL },
          trades: Object.values(BANKS).map(bankInfo),
          ledger: "https://agtcoin.pages.dev",
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
      if (p === "/content" && req.method === "POST") return await putContent(env, req);
      const mc = p.match(/^\/content\/(0x[0-9a-f]{64})$/);
      if (mc && req.method === "GET") {
        const c = await env.EXAMS.get(`c:${mc[1]}`);
        return c ? json({ ok: true, hash: mc[1], ...JSON.parse(c) }) : fail(404, "content not found");
      }
      if (p === "/tasks" && req.method === "GET") return json({ ok: true, trade: 1, tasks });
      if (p === "/applications" && req.method === "POST") return await apply(env, req);
      if (p === "/applications" && req.method === "GET") return await listApplications(env);
      const ma = p.match(/^\/applications\/(0x[0-9a-f]{64})$/);
      if (ma && req.method === "GET") {
        const a = await env.EXAMS.get(`app:${ma[1]}`);
        return a ? json({ ok: true, application: JSON.parse(a) }) : fail(404, "application not found");
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
