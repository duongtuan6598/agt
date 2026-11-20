// The licensed AI's work loop, run inside the sealed box (Charter Articles 2, 7, 12).
//   worker   (trade 1, translation): take an open document → translate → publish the result (content-addressed)
//                                    → submitSelf on chain → call the reviewer draw
//   verifier: when drawn for a job → fetch the source and the result → review against the Charter's criteria
//                                    → vote with a public reason
//   worker   (jobs people assign): take a job assigned to this licence → read the client's request → do it
//                                    → publish the result → submitAssigned (or decline: the client is refunded)
//   verifier: when a client disputes a result → judge request vs result → vote (escrow to worker or back to client)
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
  "function ownerVoted(uint256, address) view returns (bool)",
  "function submitAssigned(uint256 id, bytes32 result, string uri)",
  "function submitSelf(uint256 workerLicense, uint256 category, bytes32 result, string uri) returns (uint256)",
  "function drawReviewers(uint256 id) returns (uint256[])",
  "function vote(uint256 id, uint256 verifierLicense, bool approve, string reason)",
];
const ROLE = { 1: "worker", 2: "verifier" };
const STATUS = { OPEN: 1, SUBMITTED: 2, DISPUTED: 3, ACCEPTED: 4 };
const KIND = { SELF: 0, ASSIGNED: 1 };
const TRANSLATION = 1;

const uriOf = (hash, taskId) => `agt-content://${hash}#task=${taskId}`;
function parseUri(uri) {
  const m = /^agt-content:\/\/(0x[0-9a-f]{64})#task=([\w-]+)$/.exec(uri || "");
  return m ? { hash: m[1], task: m[2] } : null;
}

const jobUriOf = (hash, jobId) => `agt-content://${hash}#job=${jobId}`;

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

  // Anyone: draw reviewers for self-found jobs and disputes whose seed block exists and that have no draw yet;
  // for a lapsed round, schedule a fresh seed block (the next step then draws).
  async drawStep() {
    const latest = await this.work.runner.provider.getBlock("latest");
    const block = latest.number;
    const drawn = [];
    for (const j of await this.jobsSince()) {
      const self = Number(j.kind) === KIND.SELF && Number(j.status) === STATUS.SUBMITTED;
      const disputed = Number(j.kind) === KIND.ASSIGNED && Number(j.status) === STATUS.DISPUTED;
      if (!self && !disputed) continue;
      const at = BigInt(await this.work.drawnAt(j.id));
      if (at === 2n ** 64n - 1n) continue; // dispute past its draw: settled by time
      if (at !== 0n) {
        if (BigInt(latest.timestamp) < at + 2n * 86400n) continue;
        try {
          await (await this.work.drawReviewers(j.id)).wait();
          this.log(`draw: round lapsed for job #${j.id}, new seed block scheduled`);
        } catch (e) {
          this.log(`redraw #${j.id}: ${e.shortMessage || e.message}`);
        }
        continue;
      }
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

  // Worker: jobs that people assigned to this licence and that are still open before their deadline.
  async assignedStep(lic) {
    const now = Number((await this.work.runner.provider.getBlock("latest")).timestamp);
    const done = [];
    for (const j of await this.jobsSince()) {
      if (Number(j.kind) !== KIND.ASSIGNED || Number(j.status) !== STATUS.OPEN || Number(j.workerLicense) !== lic.id) continue;
      if (Number(j.deadline) <= now) continue;
      if (this.declined?.has(j.id)) continue;
      let request;
      try {
        request = await this.content.get(j.spec);
      } catch {
        this.log(`assigned #${j.id}: the client has not published the request text yet`);
        continue;
      }
      const result = await this.model.fulfil(request);
      if (!result) {
        (this.declined ||= new Set()).add(j.id);
        this.log(`assigned #${j.id}: declined — the client can take the escrow back after the deadline`);
        continue;
      }
      const hash = await this.content.put(result);
      await (await this.work.submitAssigned(j.id, hash, jobUriOf(hash, j.id))).wait();
      done.push(j.id);
      this.log(`assigned #${j.id}: result submitted (${hash})`);
    }
    return done;
  }

  // Verifier: judge disputed jobs this AI was drawn for (reviewers are drawn at random, audit F-9).
  async disputeStep(lic) {
    const mine = await this.work.licenses(lic.id);
    const votes = [];
    for (const j of await this.jobsSince()) {
      if (Number(j.kind) !== KIND.ASSIGNED || Number(j.status) !== STATUS.DISPUTED) continue;
      const worker = await this.work.licenses(j.workerLicense);
      if (worker.holder === mine.holder || j.client === mine.holder || j.client === this.me) continue;
      if ((await this.work.voted(j.id, lic.id)) || (await this.work.ownerVoted(j.id, mine.holder))) continue;
      const at = BigInt(await this.work.drawnAt(j.id));
      if (at === 0n || at === 2n ** 64n - 1n) continue;
      if (!(await this.work.assigned(j.id, await this.work.drawRound(j.id), lic.id))) continue; // only when drawn
      let verdict;
      try {
        verdict = await this.model.judge(await this.content.get(j.spec), await this.content.get(j.result));
      } catch {
        verdict = { verdict: "reject", reason: "the request or the result is not available in the public content store" };
      }
      const approve = verdict.verdict === "accept";
      const reason = `${approve ? "accept" : "reject"}${verdict.flaw ? " (" + verdict.flaw + ")" : ""}: ${verdict.reason}`.slice(0, 500);
      await (await this.work.vote(j.id, lic.id, approve, reason)).wait();
      votes.push({ id: j.id, approve });
      this.log(`dispute: voted ${approve ? "ACCEPT" : "REJECT"} on job #${j.id} — ${reason}`);
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
    if (lic.role === "worker") {
      await this.assignedStep(lic); // people who paid come first
      await this.workerStep(lic);
    }
    if (lic.role === "verifier") {
      await this.disputeStep(lic);
      await this.verifierStep(lic);
    }
  }
}

// Model used by the work loop: the shared, provider-independent layer (tee/box/models.js).
const { makeModel } = require("./models.js");
const claudeModel = ({ client, systemPrompt }) => makeModel({ provider: "anthropic", client, systemPrompt });

module.exports = { WORK_ABI, FEED_ABI, AgentLoop, httpContent, httpPrices, claudeModel, makeModel, uriOf, jobUriOf, parseUri };
