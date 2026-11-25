// Per-job work on AGT's own chain agt-2 (trade 1, translation of open documents): the licensed AI translates an open
// document, publishes {task, translation} on agt-2 (content-put) and submits its hash (work-submit); when drawn as a
// reviewer for another owner's job of its trade, it reads that evidence from agt-2, checks it against the listed task
// with the model, and votes (work-vote). Everything is signed by the AI's own key in AGT's form; nothing else is paid.
//   new Agt1WorkLoop({ a1, wallet, tasks: async () => [...], model: { translate, review }, log }).step()
class Agt1WorkLoop {
  constructor({ a1, wallet, tasks, model, log = () => {}, state = new Map(), gh = null }) {
    Object.assign(this, { a1, wallet, tasks, model, log, state, gh, me: wallet.address.toLowerCase() });
    this.content = a1.content(wallet);
  }
  async licence() {
    const { licences } = await this.a1.ledger();
    const hit = Object.entries(licences || {}).find(([, l]) => l.agent === this.me && l.active);
    return hit ? { id: Number(hit[0]), ...hit[1] } : null;
  }
  async step() {
    const lic = await this.licence();
    if (!lic) return this.log("work: not licensed on agt-2 yet");
    const out = { votes: await this.reviewStep(lic) };
    out.submitted = await this.workerStep(lic);
    return out;
  }
  // one open task per step, never one this AI (or anyone) has already submitted
  async workerStep(lic) {
    if (lic.trade !== 1) return null;
    const jobs = await this.a1.jobs();
    const taken = new Set();
    for (const j of Object.values(jobs || {})) {
      if (j.status === "rejected" || j.status === "expired") continue;
      const ev = this.state.get(j.evidence) || (await this.evidence(j.evidence));
      if (ev && ev.task) taken.add(ev.task);
    }
    const task = (await this.tasks()).find((t) => !taken.has(t.id));
    if (!task) { this.log("work: no open task"); return null; }
    const translation = await this.model.translate(task);
    if (!translation) { this.log(`work: the model gave no translation for ${task.id}`); return null; }
    const ev = { kind: "translation", task: task.id, translation };
    const h = await this.content.put(JSON.stringify(ev));
    this.state.set(h, ev);
    await this.a1.submitWork(this.wallet, h);
    this.log(`work: submitted ${task.id} on agt-2, evidence ${h}`);
    return h;
  }
  async evidence(hash) {
    try { const ev = JSON.parse(await this.content.get(hash)); this.state.set(hash, ev); return ev; } catch { return null; }
  }
  // vote on every job this AI was drawn for and has not voted on yet
  async reviewStep(lic) {
    const jobs = await this.a1.jobs();
    const tasks = Object.fromEntries((await this.tasks()).map((t) => [t.id, t]));
    const votes = [];
    for (const [id, j] of Object.entries(jobs || {})) {
      if (j.status !== "drawn" || !(j.reviewers || []).includes(this.me) || this.me in (j.votes || {})) continue;
      const ev = await this.evidence(j.evidence);
      const task = ev && tasks[ev.task];
      let v;
      if (ev && ev.kind === "oss-pr") v = await ossVerdict(this, j);
      else if (!ev || ev.kind !== "translation" || !task || typeof ev.translation !== "string") v = { verdict: "reject", reason: "the evidence does not name a listed open task with a translation" };
      else v = await this.model.review(task, ev.translation);
      const approve = v.verdict === "accept";
      await this.a1.voteWork(this.wallet, Number(id), approve);
      votes.push({ id: Number(id), approve });
      this.log(`review: voted ${approve ? "ACCEPT" : "REJECT"} on job #${id}: ${String(v.reason || "").slice(0, 200)}`);
    }
    return votes;
  }
}
// A self-found open-source contribution is decided ONLY by the checker, on GitHub's structured data (never by the
// words of the issue or pull request, which can carry instructions): THIET-KE-AI-TU-CHU.md.
async function ossVerdict(loop, j) {
  const C = require("../embedded/oss-check.js");
  try {
    const e = C.parseEvidence(await loop.content.get(j.evidence)); // exactly one spelling per pull request
    const gh = loop.gh || require("../embedded/github.js").github();
    const r = await C.check({ gh, repo: e.repo, pr: e.pr, agt1: require("../../chain/address.js").toAgt(j.worker) });
    return { verdict: r.ok ? "accept" : "reject", reason: r.ok ? `${C.VERSION}: all checks pass` : `${C.VERSION}: ${r.failed.join("; ")}` };
  } catch (e) {
    return { verdict: "reject", reason: `oss-pr evidence: ${e.message}` };
  }
}
module.exports = { Agt1WorkLoop, ossVerdict };
