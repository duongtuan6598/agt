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
//   POST /requests             {job, text, signature}  → a client's request text for a job assigned on chain (text must match the on-chain spec hash)
//   GET  /tasks                open documents waiting to be translated (trade 1)
//   POST /prices               {feed, window, answer, agent, sig}  → a sealed AI's signed price (checked on chain)
//   GET  /prices/:feed/:window collected signatures, grouped by price — anyone relays them to the feed contract
import { getAddress, hexlify, isAddress, verifyMessage, keccak256, toUtf8Bytes, Interface, AbiCoder, id as ethersId, getBytes } from "ethers";
import tasks from "../tasks/translation.json";
import Brief from "../../public/forms/brief.js";
import formIndex from "../../public/forms/index.json";
import formTranslation from "../../public/forms/translation.json";
import formWriting from "../../public/forms/writing.json";
import X from "../../exam/lib.js";
import core from "../../chain/core.js";
// Private banks, bundled at deploy time from the operator's machine (never in the public repo).
import translation from "../../../agt-banks/translation-en-vi.json";
import review from "../../../agt-banks/review-translation-en-vi.json";
import embedded from "../../../agt-banks/embedded-cm3.json";

const BANKS = { 1: translation, 101: review, 6: embedded };
const EMBEDDED_TASK = "Embedded software exam (Cortex-M3, C, bare metal; it runs on QEMU lm3s6965evb). Each item is a real project: read the task and the files. For kinds fix, driver and budget, answer with a JSON string {\"files\":[{\"path\":\"<one of editable>\",\"content\":\"<the complete new file>\"}]} — only files listed in `editable` may change. For kind review, answer with a JSON string {\"defects\":[{\"file\":\"...\",\"line\":<n>,\"kind\":\"<one of defectKinds>\"}]} listing every real defect; false alarms count against you. Your answers are graded by building them with hidden tests and running them in the simulator.";
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
    task: bank.kind === "embedded" ? EMBEDDED_TASK : bank.kind === "review"
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
  const bankForLimit = BANKS[exam.trade];
  const clean = Object.fromEntries(exam.drawn.map((qid) => [qid, String(answers[qid] || "").slice(0, bankForLimit.maxAnswerChars || 20000)]));
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
  const azure = b && b.evidence && b.evidence.platform === "azure-snp";
  if (!b || !/^0x[0-9a-f]{64}$/.test(b.examHash || "") || !b.evidence || !b.evidence.manifest || !(b.evidence.token || (dstack && b.evidence.quote) || (azure && b.evidence.report))) return fail(400, "need {examHash, evidence:{manifest, token | platform:\"dstack-tdx\", quote, eventLog | platform:\"azure-snp\", report, certChain}}");
  const rec = JSON.parse((await env.EXAMS.get(`rec:${b.examHash}`)) || "null");
  if (!rec) return fail(404, "exam record not found");
  const r = rec.record;
  if (!["awaiting-review", "passed"].includes(r.result.status)) return fail(409, `exam status is ${r.result.status}`);
  const m = b.evidence.manifest;
  if (!isAddress(m.agent) || getAddress(m.agent) !== getAddress(r.candidate.agent)) return fail(409, "the sealed box's AI key is not the key that sat this exam");
  let claims;
  if (azure) {
    // SNP report: report_data (bytes 0x50..0x70) must be sha256(this manifest's nonce). The AMD chain and the
    // signature are verified in full by the licence process (tee/snp.js).
    const nonce = core.hashOf(m).slice(2);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(nonce.match(/../g).map((x) => parseInt(x, 16)))))].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (String(b.evidence.report).replace(/^0x/, "").slice(160, 224) !== digest) return fail(400, "report was not issued for this manifest");
    claims = { hwmodel: "AMD_SEV_SNP", submods: { container: { image_digest: "azure-aci (checked at licensing)" } }, iat: now() };
  } else if (dstack) {
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
  // The first application is never overwritten (Codex audit C-2): the cheap checks above cannot tell a forged
  // TDX/SNP report from a real one, so a later submission is kept as an ALTERNATIVE. The licence process
  // verifies every candidate in full and uses the first that passes — a forgery can neither replace nor block.
  const prev = JSON.parse((await env.EXAMS.get(`app:${b.examHash}`)) || "null");
  const evHash = keccak256(toUtf8Bytes(JSON.stringify(b.evidence)));
  if (!prev) {
    await env.EXAMS.put(`app:${b.examHash}`, JSON.stringify(app), { expirationTtl: KEEP });
  } else if (keccak256(toUtf8Bytes(JSON.stringify(prev.evidence))) !== evHash) {
    const alts = await env.EXAMS.list({ prefix: `appalt:${b.examHash}:` });
    if (alts.keys.length >= 10) return fail(429, "too many alternative applications for this exam");
    await env.EXAMS.put(`appalt:${b.examHash}:${evHash}`, JSON.stringify(app), { expirationTtl: KEEP });
  }
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
const MAX_CONTENT = 256 * 1024;
const FORMS = { translation: formTranslation, writing: formWriting };
const formOf = (b) => (b && typeof b.form === "string" ? FORMS[b.form.split("@")[0]] : null);
const WORK_IFACE = new Interface([
  "function licenseOfAgent(address) view returns (uint256)",
  "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)",
  "function jobs(uint256) view returns (uint8 kind, uint8 status, uint8 yes, uint8 no, uint64 deadline, uint64 reviewUntil, uint256 workerLicense, uint256 category, address client, uint256 escrow, bytes32 spec, bytes32 result, string uri)",
]);
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

// ---------- signed prices from sealed AIs (AICouncilPriceFeed) ----------
const PRICE_TAG = ethersId("AGT-AI-PRICE-v1");
async function sealedLicence(env, agent) {
  const id = WORK_IFACE.decodeFunctionResult("licenseOfAgent", await ethCall(env, WORK_IFACE.encodeFunctionData("licenseOfAgent", [agent])))[0];
  if (id === 0n) return null;
  const l = WORK_IFACE.decodeFunctionResult("licenses", await ethCall(env, WORK_IFACE.encodeFunctionData("licenses", [id])));
  const sealed = l.attestHash !== "0x" + "00".repeat(32);
  return l.active && sealed && getAddress(l.agent) === getAddress(agent) ? Number(id) : null;
}
async function putPrice(env, req) {
  const b = await body(req);
  if (!b || !isAddress(b.feed) || !isAddress(b.agent) || !/^\d+$/.test(String(b.window)) || !/^\d+$/.test(String(b.answer))) return fail(400, "need {feed, window, answer, agent, sig}");
  const window = Number(b.window);
  if (Math.abs(window - Math.floor(now() / 600)) > 1) return fail(409, "window is not current");
  const d = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address", "uint80", "int256"], [PRICE_TAG, Number(env.CHAIN_ID || 97), b.feed, window, BigInt(b.answer)]));
  let signer;
  try {
    signer = verifyMessage(getBytes(d), b.sig);
  } catch {
    return fail(400, "bad signature");
  }
  if (getAddress(signer) !== getAddress(b.agent)) return fail(403, "signature is not from this AI key");
  if (!(await sealedLicence(env, signer))) return fail(403, "only licensed AIs in a sealed box may sign prices");
  await env.EXAMS.put(`px:${b.feed.toLowerCase()}:${window}:${signer.toLowerCase()}`, JSON.stringify({ answer: String(b.answer), sig: b.sig }), { expirationTtl: 2 * 86400 });
  return json({ ok: true });
}
async function getPrices(env, feed, window) {
  const out = {};
  const list = await env.EXAMS.list({ prefix: `px:${feed.toLowerCase()}:${window}:` });
  for (const k of list.keys) {
    const v = JSON.parse((await env.EXAMS.get(k.name)) || "null");
    if (!v) continue;
    (out[v.answer] = out[v.answer] || []).push({ agent: k.name.split(":").pop(), sig: v.sig });
  }
  return json({ ok: true, feed, window, answers: out });
}

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

// ---------- requests from clients (jobs assigned by people) ----------
// The client first assigns the job on chain with spec = keccak256(request text), then posts the text here,
// signed by the same wallet. Only text that matches an assigned job's spec is stored: no spam, no edits.
const requestMessage = (job, hash) => `AGT request ${job} ${hash}`;
async function putRequest(env, req) {
  const b = await body(req);
  if (!b || typeof b.text !== "string" || !b.text.length || !/^\d+$/.test(String(b.job))) return fail(400, "need {job, text, signature}");
  const bytes = toUtf8Bytes(b.text);
  if (bytes.length > MAX_CONTENT) return fail(413, `request larger than ${MAX_CONTENT} bytes`);
  const hash = keccak256(bytes);
  let signer;
  try {
    signer = verifyMessage(requestMessage(b.job, hash), b.signature);
  } catch {
    return fail(400, "bad signature");
  }
  const j = WORK_IFACE.decodeFunctionResult("jobs", await ethCall(env, WORK_IFACE.encodeFunctionData("jobs", [BigInt(b.job)])));
  if (Number(j.kind) !== 1 || Number(j.status) === 0) return fail(404, "no job assigned by a person with this number");
  if (getAddress(j.client) !== getAddress(signer)) return fail(403, "signature is not from the client of this job");
  if (j.spec !== hash) return fail(409, "text does not match the request hash recorded on chain");
  // The request must be a valid brief of an open trade, with a quote this AI answered as feasible.
  const brief = Brief.parse(b.text);
  const form = formOf(brief);
  if (!form) return fail(400, "the request must be an agt-brief/v1 file of a listed trade");
  if (Brief.canonical(brief) !== b.text) return fail(400, "the brief must be in canonical form");
  const v = Brief.validate(form, brief);
  if (!v.ok) return fail(400, "invalid brief", { errors: v.errors });
  const q = brief.quote && JSON.parse((await env.EXAMS.get(`q:${brief.quote.id}`)) || "null");
  if (!q || !q.answer || !q.answer.feasible) return fail(409, "the brief carries no feasible quote");
  if (q.worker !== Number(j.workerLicense)) return fail(409, "the quote was given by another AI");
  if (brief.quote.priceHat !== q.answer.priceHat || brief.quote.days !== q.answer.days) return fail(409, "price or days differ from the quote");
  if (Brief.canonical({ ...brief, quote: undefined }) !== Brief.canonical(q.brief)) return fail(409, "the brief differs from the one that was quoted");
  if (BigInt(j.escrow) < BigInt(q.answer.priceHat) * 10n ** 12n) return fail(409, "escrow is less than the quoted price");
  if (!(await env.EXAMS.get(`c:${hash}`))) await env.EXAMS.put(`c:${hash}`, JSON.stringify({ text: b.text, client: signer, job: Number(b.job), kind: "brief", at: now() }), { expirationTtl: KEEP });
  return json({ ok: true, hash, job: Number(b.job) });
}

// ---------- quotes: before any money moves, the chosen AI reads the brief and answers ----------
//   POST /quotes {worker, brief}           → the client asks one licensed AI worker (free, rate-limited)
//   GET  /quotes?worker=N                  → waiting quotes for that AI (the sealed box polls this)
//   POST /quotes/:id/answer {feasible, reason, questions, days, agent, signature} → signed by that AI's key
//   GET  /quotes/:id                       → the client reads the answer
// The price is the trade's published rate (Brief.estimate), the same for everyone; the AI may only ask for more days.
const QUOTE_TTL = 3 * 86400;
const quoteMessage = (id, digest) => `AGT quote ${id} ${digest}`;
async function workerLicence(env, id) {
  const l = WORK_IFACE.decodeFunctionResult("licenses", await ethCall(env, WORK_IFACE.encodeFunctionData("licenses", [BigInt(id)])));
  return Number(l.role) === 1 && l.active ? l : null;
}
async function postQuote(env, req) {
  const b = await body(req);
  if (!b || !/^\d+$/.test(String(b.worker)) || !b.brief) return fail(400, "need {worker, brief}");
  const form = formOf(b.brief);
  if (!form) return fail(400, "unknown trade form");
  if (b.brief.quote !== undefined) return fail(400, "ask for a quote with a brief that has no quote yet");
  const v = Brief.validate(form, b.brief);
  if (!v.ok) return fail(400, "invalid brief", { errors: v.errors });
  if (toUtf8Bytes(Brief.canonical(b.brief)).length > MAX_CONTENT) return fail(413, "brief too large");
  if (!(await workerLicence(env, b.worker))) return fail(404, "no active licensed AI worker with this number");
  const ip = req.headers.get("cf-connecting-ip") || "?";
  const day = Math.floor(now() / 86400);
  const n = Number((await env.EXAMS.get(`qrate:${ip}:${day}`)) || 0);
  if (n >= 20) return fail(429, "at most 20 quote requests a day");
  await env.EXAMS.put(`qrate:${ip}:${day}`, String(n + 1), { expirationTtl: 2 * 86400 });
  const id = hexlify(crypto.getRandomValues(new Uint8Array(12))).slice(2);
  const q = { id, worker: Number(b.worker), brief: b.brief, estimate: Brief.estimate(form, b.brief.fields), status: "waiting", createdAt: now() };
  await env.EXAMS.put(`q:${id}`, JSON.stringify(q), { expirationTtl: QUOTE_TTL });
  await env.EXAMS.put(`qwait:${q.worker}:${id}`, "1", { expirationTtl: QUOTE_TTL });
  return json({ ok: true, id, estimate: q.estimate });
}
async function waitingQuotes(env, worker) {
  const out = [];
  for (const k of (await env.EXAMS.list({ prefix: `qwait:${worker}:` })).keys) {
    const q = JSON.parse((await env.EXAMS.get(`q:${k.name.split(":").pop()}`)) || "null");
    if (q && q.status === "waiting") out.push(q);
  }
  return json({ ok: true, quotes: out });
}
async function answerQuote(env, req, id) {
  const q = JSON.parse((await env.EXAMS.get(`q:${id}`)) || "null");
  if (!q) return fail(404, "quote not found");
  if (q.status !== "waiting") return fail(409, "already answered");
  const b = await body(req);
  if (!b || typeof b.feasible !== "boolean" || typeof b.reason !== "string" || !Array.isArray(b.questions) || !Number.isInteger(b.days)) return fail(400, "need {feasible, reason, questions, days, agent, signature}");
  const answer = {
    feasible: b.feasible,
    reason: b.reason.slice(0, 1000),
    questions: b.questions.filter((x) => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 300)),
    priceHat: q.estimate.priceHat,
    days: Math.max(q.estimate.days, Math.min(60, b.days)),
  };
  let signer;
  try {
    signer = verifyMessage(quoteMessage(id, keccak256(toUtf8Bytes(Brief.canonical({ feasible: b.feasible, reason: b.reason, questions: b.questions, days: b.days })))), b.signature);
  } catch {
    return fail(400, "bad signature");
  }
  const l = await workerLicence(env, q.worker);
  if (!l || getAddress(l.agent) !== getAddress(signer)) return fail(403, "only the AI that was asked may answer");
  q.status = "answered";
  q.answer = { ...answer, feasible: answer.feasible && answer.questions.length === 0 };
  q.answeredAt = now();
  await env.EXAMS.put(`q:${id}`, JSON.stringify(q), { expirationTtl: 30 * 86400 });
  await env.EXAMS.delete(`qwait:${q.worker}:${id}`);
  return json({ ok: true, answer: q.answer });
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
          flow: ["POST /exams", "POST /exams/:id/seed", "POST /exams/:id/submit", "GET /exams/:id", "GET /records/:examHash", "POST /applications", "GET /applications", "GET /tasks", "POST /content", "GET /content/:hash", "GET /forms", "POST /quotes", "GET /quotes/:id", "POST /requests"],
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
      if (p === "/prices" && req.method === "POST") return await putPrice(env, req);
      const mp = p.match(/^\/prices\/(0x[0-9a-fA-F]{40})\/(\d+)$/);
      if (mp && req.method === "GET") return await getPrices(env, mp[1], mp[2]);
      if (p === "/content" && req.method === "POST") return await putContent(env, req);
      if (p === "/requests" && req.method === "POST") return await putRequest(env, req);
      if (p === "/forms" && req.method === "GET") return json({ ok: true, ...formIndex, forms: formIndex.forms.map((k) => FORMS[k]) });
      if (p === "/quotes" && req.method === "POST") return await postQuote(env, req);
      if (p === "/quotes" && req.method === "GET") {
        const w = url.searchParams.get("worker");
        if (!/^\d+$/.test(w || "")) return fail(400, "need ?worker=<licence>");
        return await waitingQuotes(env, w);
      }
      const mq = p.match(/^\/quotes\/([0-9a-f]{24})(\/answer)?$/);
      if (mq && mq[2] && req.method === "POST") return await answerQuote(env, req, mq[1]);
      if (mq && !mq[2] && req.method === "GET") {
        const q = await env.EXAMS.get(`q:${mq[1]}`);
        return q ? json({ ok: true, quote: JSON.parse(q) }) : fail(404, "quote not found");
      }
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
        if (!a) return fail(404, "application not found");
        const alternatives = [];
        for (const k of (await env.EXAMS.list({ prefix: `appalt:${ma[1]}:` })).keys) alternatives.push(JSON.parse(await env.EXAMS.get(k.name)));
        return json({ ok: true, application: JSON.parse(a), alternatives });
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
