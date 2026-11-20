// The licensed AI's work loop, run inside the sealed box (Charter Articles 2, 7, 12).
//   worker   (trade 1, translation): take an open document → translate → publish the result (content-addressed)
//                                    → submitSelf on chain → call the reviewer draw
//   verifier: when drawn for a job → fetch the source and the result → review against the Charter's criteria
//                                    → vote with a public reason
//   anyone:  call drawReviewers for jobs whose seed block has arrived (keeps reviews moving)
// Every transaction is signed by the AI's own key; the owner only funds that key with gas.
const { ethers } = require("ethers");

const WORK_ABI = [
  "function licenseOfAgent(address) view returns (uint256)",
  "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)",
  "function jobs(uint256) view returns (uint8 kind, uint8 status, uint8 yes, uint8 no, uint64 deadline, uint64 reviewUntil, uint256 workerLicense, uint256 category, address client, uint256 escrow, bytes32 spec, bytes32 result, string uri)",
  "function nextJob() view returns (uint256)",
  "function drawBlock(uint256) view returns (uint256)",
  "function drawnAt(uint256) view returns (uint64)",
  "function drawRound(uint256) view returns (uint32)",
  "function assigned(uint256, uint32, uint256) view returns (bool)",
  "function voted(uint256, uint256) view returns (bool)",
  "function submitSelf(uint256 workerLicense, uint256 category, bytes32 result, string uri) returns (uint256)",
  "function drawReviewers(uint256 id) returns (uint256[])",
  "function vote(uint256 id, uint256 verifierLicense, bool approve, string reason)",
];
const ROLE = { 1: "worker", 2: "verifier" };
const STATUS = { SUBMITTED: 2, ACCEPTED: 4 };
const TRANSLATION = 1;

const uriOf = (hash, taskId) => `agt-content://${hash}#task=${taskId}`;
function parseUri(uri) {
  const m = /^agt-content:\/\/(0x[0-9a-f]{64})#task=([\w-]+)$/.exec(uri || "");
  return m ? { hash: m[1], task: m[2] } : null;
}

// HTTP client for the public content store and task list (the exam worker).
function httpContent(base, wallet) {
  return {
    async tasks() {
      return (await (await fetch(`${base}/tasks`)).json()).tasks;
    },
    async put(text) {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(text));
      const r = await (await fetch(`${base}/content`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, agent: wallet.address, signature: await wallet.signMessage(`AGT content ${hash}`) }),
      })).json();
      if (!r.ok) throw new Error(`content store: ${r.error}`);
      return r.hash;
    },
    async get(hash) {
      const r = await (await fetch(`${base}/content/${hash}`)).json();
      if (!r.ok) throw new Error(`content ${hash}: ${r.error}`);
      return r.text;
    },
  };
}

class AgentLoop {
  // work: ethers Contract connected to the AI's signer · content: {tasks, put, get} · model: {translate, review}
  constructor({ work, me, content, model, log = () => {} }) {
    Object.assign(this, { work, me, content, model, log });
  }

  async licence() {
    const id = await this.work.licenseOfAgent(this.me);
    if (id === 0n) return null;
    const l = await this.work.licenses(id);
    return l.active ? { id: Number(id), role: ROLE[Number(l.role)] } : null;
  }

  async jobsSince(from = 1) {
    const out = [];
    const n = Number(await this.work.nextJob());
    for (let id = from; id < n; id++) out.push({ id, ...(await this.work.jobs(id)).toObject() });
    return out;
  }

  // Worker: one open task that nobody has submitted yet (or whose earlier submission was rejected).
  async workerStep(lic) {
    const jobs = await this.jobsSince();
    const taken = new Set(jobs.filter((j) => [STATUS.SUBMITTED, STATUS.ACCEPTED].includes(Number(j.status))).map((j) => parseUri(j.uri)?.task).filter(Boolean));
    const task = (await this.content.tasks()).find((t) => !taken.has(t.id));
    if (!task) return this.log("worker: no open task");
    const text = await this.model.translate(task);
    if (!text) return this.log(`worker: model gave no translation for ${task.id}`);
    const hash = await this.content.put(text);
    const tx = await this.work.submitSelf(lic.id, TRANSLATION, hash, uriOf(hash, task.id));
    await tx.wait();
    const id = Number(await this.work.nextJob()) - 1;
    this.log(`worker: submitted job #${id} (${task.id}), result ${hash}`);
    return id;
  }

  // Anyone: draw reviewers for jobs whose seed block exists and that have no draw yet (or a lapsed one).
  async drawStep() {
    const block = await this.work.runner.provider.getBlockNumber();
    const drawn = [];
    for (const j of await this.jobsSince()) {
      if (Number(j.status) !== STATUS.SUBMITTED || Number(j.kind) !== 0) continue;
      if (Number(await this.work.drawnAt(j.id)) !== 0) continue;
      if (block <= Number(await this.work.drawBlock(j.id))) continue;
      try {
        await (await this.work.drawReviewers(j.id)).wait();
        drawn.push(j.id);
        this.log(`draw: reviewers drawn for job #${j.id}`);
      } catch (e) {
        this.log(`draw #${j.id}: ${e.shortMessage || e.message}`);
      }
    }
    return drawn;
  }

  // Verifier: review every job this AI is currently drawn for and has not voted on.
  async verifierStep(lic) {
    const tasks = Object.fromEntries((await this.content.tasks()).map((t) => [t.id, t]));
    const votes = [];
    for (const j of await this.jobsSince()) {
      if (Number(j.status) !== STATUS.SUBMITTED || Number(j.kind) !== 0) continue;
      if (Number(await this.work.drawnAt(j.id)) === 0) continue;
      const round = await this.work.drawRound(j.id);
      if (!(await this.work.assigned(j.id, round, lic.id)) || (await this.work.voted(j.id, lic.id))) continue;
      const ref = parseUri(j.uri);
      const task = ref && tasks[ref.task];
      let verdict;
      if (!ref || !task || ref.hash !== j.result) verdict = { verdict: "reject", reason: "the result does not point to a listed open task with matching content hash" };
      else verdict = await this.model.review(task, await this.content.get(ref.hash));
      const approve = verdict.verdict === "accept";
      const reason = `${approve ? "accept" : "reject"}${verdict.flaw ? " (" + verdict.flaw + ")" : ""}: ${verdict.reason}`.slice(0, 500);
      await (await this.work.vote(j.id, lic.id, approve, reason)).wait();
      votes.push({ id: j.id, approve });
      this.log(`verifier: voted ${approve ? "ACCEPT" : "REJECT"} on job #${j.id} — ${reason}`);
    }
    return votes;
  }

  async step() {
    const lic = await this.licence();
    if (!lic) return this.log("agent: not licensed yet — waiting");
    await this.drawStep();
    if (lic.role === "worker") await this.workerStep(lic);
    if (lic.role === "verifier") await this.verifierStep(lic);
  }
}

// Claude-backed model, using the same fixed model and attested system prompt as the exam.
function claudeModel({ client, systemPrompt }) {
  const { MODEL, REVIEW_SCHEMA } = require("./answer.js");
  const text = (r) => (r.stop_reason === "refusal" ? null : r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim());
  const base = { model: MODEL, max_tokens: 16000, system: systemPrompt, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  return {
    async translate(task) {
      const r = await client.beta.messages.create({
        ...base, output_config: { effort: "high" },
        messages: [{ role: "user", content: `Translate this open document from English into Vietnamese. Keep links, code spans and every number exactly as written, use the glossary term for each listed source term, keep the same paragraphs. Answer with the translation only.\n\nTask (JSON):\n${JSON.stringify({ title: task.title, glossary: task.glossary, source: task.source }, null, 2)}` }],
      });
      return text(r);
    },
    async review(task, translation) {
      const r = await client.beta.messages.create({
        ...base, output_config: { effort: "high", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
        messages: [{ role: "user", content: `You were drawn at random to review another AI's work for AGT. Decide whether the Vietnamese translation faithfully renders the English source: complete meaning, every number, the required glossary terms, nothing added, fully translated. Accepting a flawed translation mints AGT for bad work — when in doubt, reject. Answer with the JSON object only.\n\nItem (JSON):\n${JSON.stringify({ source: task.source, glossary: task.glossary, translation }, null, 2)}` }],
      });
      const t = text(r);
      return t ? JSON.parse(t) : { verdict: "reject", flaw: "meaning", reason: "model declined to review this item" };
    },
  };
}

module.exports = { WORK_ABI, AgentLoop, httpContent, claudeModel, uriOf, parseUri };
