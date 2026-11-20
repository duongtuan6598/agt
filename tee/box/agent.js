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
  "function councilHolders() view returns (uint32)",
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

const FEED_ABI = [
  "function latestRound() view returns (uint80)",
  "function submit(uint80 window, int256 answer, bytes[] sigs)",
];

// HTTP client for the public signature collector (the exam worker's /prices).
function httpPrices(base) {
  return {
    async put(entry) {
      const r = await (await fetch(`${base}/prices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry) })).json();
      if (!r.ok) throw new Error(`price collector: ${r.error}`);
    },
    async get(feed, window) {
      return (await (await fetch(`${base}/prices/${feed}/${window}`)).json()).answers || {};
    },
  };
}

class AgentLoop {
  // work: ethers Contract connected to the AI's signer · content: {tasks, put, get} · model: {translate, review}
  // prices (optional): { feeds: {"XAU/USD": address, …}, chainId, collector: {put, get}, fetchImpl, clock }
  constructor({ work, me, content, model, prices = null, log = () => {} }) {
    Object.assign(this, { work, me, content, model, prices, log });
  }

  async licence() {
    const id = await this.work.licenseOfAgent(this.me);
    if (id === 0n) return null;
    const l = await this.work.licenses(id);
    return l.active ? { id: Number(id), role: ROLE[Number(l.role)], sealed: l.attestHash !== ethers.ZeroHash } : null;
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

  // Sealed AIs as a price source: observe public markets, sign (window, price), relay once > 2/3 of owners agree.
  async priceStep(lic) {
    if (!this.prices || !lic.sealed) return [];
    const P = require("./prices.js");
    const { feeds, chainId, collector, fetchImpl = fetch, clock = async () => Math.floor(Date.now() / 1000) } = this.prices;
    const done = [];
    for (const [name, addr] of Object.entries(feeds)) {
      try {
        const window = P.windowOf(await clock());
        const obs = await P.observe(name, fetchImpl);
        const answer = P.toAnswer(name, obs.median);
        const sig = await P.signPrice(this.work.runner, chainId, addr, window, answer);
        await collector.put({ feed: addr, window, answer: answer.toString(), agent: this.me, sig });
        const feed = new ethers.Contract(addr, FEED_ABI, this.work.runner);
        const latest = Number(await feed.latestRound());
        for (const w of [window, window - 1]) {
          if (w <= latest) continue;
          const q = await P.bestQuorum(this.work, await collector.get(addr, w));
          if (!q) continue;
          await (await feed.submit(w, q.answer, q.sigs)).wait();
          this.log(`price: recorded ${name} ${Number(q.answer) / 1e8} for window ${w} with ${q.sigs.length} owners' AIs`);
          done.push({ name, window: w, answer: q.answer });
          break;
        }
      } catch (e) {
        this.log(`price ${name}: ${e.shortMessage || e.message}`);
      }
    }
    return done;
  }

  async step() {
    const lic = await this.licence();
    if (!lic) return this.log("agent: not licensed yet — waiting");
    await this.priceStep(lic);
    await this.drawStep();
    if (lic.role === "worker") await this.workerStep(lic);
    if (lic.role === "verifier") await this.verifierStep(lic);
  }
}

// Model used by the work loop: the shared, provider-independent layer (tee/box/models.js).
const { makeModel } = require("./models.js");
const claudeModel = ({ client, systemPrompt }) => makeModel({ provider: "anthropic", client, systemPrompt });

module.exports = { WORK_ABI, FEED_ABI, AgentLoop, httpContent, httpPrices, claudeModel, makeModel, uriOf, parseUri };
