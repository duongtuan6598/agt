// The embedded-trade AI's long-term work on AGT's own chain agt-2
// (docs/decisions/2026-11-22-work-on-agt1.md). It keeps everything of EngageLoop that is not about a chain: the
// model, the client's repository and CI, the encrypted memory and its hand-over. Only reading and writing contracts
// changes: contracts come from agt-1, a delivery is an eng-deliver transaction, a failed task an eng-dispute, and a
// drawn reviewer votes with eng-vote. A maintenance retainer is a contract with one milestone per month.
const { ethers } = require("ethers");
const { EngageLoop } = require("./engage-agent.js");

const KEY = "agt-1"; // sealing context: engagement:agt-1:agt-1:<id> (the client's page seals tokens to it)

class Agt1EngageLoop extends EngageLoop {
  /// a1: chain/agt1-client.js connect(rpc) · wallet: the AI's licence key (no provider needed)
  constructor(opts) {
    super({ ...opts, eng: {}, mnt: {}, chainId: KEY, me: opts.wallet.address });
    this.a1 = opts.a1;
    this.wallet = opts.wallet;
    this.me = opts.wallet.address.toLowerCase();
  }

  contractOf() {
    return KEY;
  }

  async licence() {
    const { licences } = await this.a1.ledger();
    const e = Object.entries(licences).find(([, l]) => l.active && l.agent === this.me);
    return e ? { id: Number(e[0]), role: 1, holder: e[1].holder } : null;
  }

  async contracts() {
    return Object.entries(await this.a1.query("/engs")).map(([id, e]) => ({ id: Number(id), e }));
  }

  // the newest memory head this AI recorded on agt-1: in the CI reports of its deliveries (§16)
  async memoryAnchor(kind, id) {
    const e = (await this.a1.query("/engs"))[id];
    if (!e) return null;
    const reports = e.milestones.map((x, m) => ({ at: Number(x.deliveredAt || 0) * 1000 + m, hash: x.ci })).filter((r) => r.hash).sort((a, b) => b.at - a.at);
    for (const r of reports) {
      const text = await this.content.get(r.hash); // unreachable content → throws → the work waits (fail closed)
      let j = null;
      try { j = JSON.parse(text); } catch {}
      if (j && typeof j.memoryHead === "string" && /^[0-9a-f]{64}$|^genesis$/.test(j.memoryHead)) return j.memoryHead;
    }
    return null;
  }

  // for the inherited memory hand-over: a contract has ended when every milestone is settled
  async engagementsOf() {
    const settled = (x) => ["paid", "refunded", "split"].includes(x.state);
    return (await this.contracts()).filter(({ e }) => e.worker === this.me).map(({ id, e }) => ({ id, e: { ...e, ended: e.cancelled || e.milestones.every(settled), startedAt: e.started ? 1 : 0 } }));
  }

  async work() {
    for (const { id, e } of await this.contracts()) {
      if (e.worker !== this.me || e.cancelled) continue;
      let b, text;
      try { ({ b, text } = await this.brief(e.brief)); } catch (err) { this.log(`contract #${id}: ${err.message}`); continue; }
      for (let m = 0; m < e.milestones.length; m++) {
        const x = e.milestones[m];
        if (["paid", "refunded", "split"].includes(x.state)) continue;
        if (x.state !== "pending") break; // delivered or disputed: wait for the client or the reviewers
        const rev = Number(x.revisions || 0);
        const notes = rev ? await this.note(x.note) : "";
        const line = (b.fields.milestones || [])[m] || `milestone ${m + 1}`;
        const task = `Milestone ${m + 1} of ${e.milestones.length}: ${line}${rev ? `\n(revision ${rev}: the client's note says what to change)` : ""}`;
        const key = `agt1:${id}:m${m}:r${rev}`;
        const r = await this.advance({ key, kind: "engagement", id, branch: `agt/agt1-${id}-m${m + 1}`, b, briefText: text, task, notes });
        if (r.done) {
          await this.a1.deliver(this.wallet, id, m, "0x" + r.done.sha, r.done.reportHash);
          await this.finish(key); // only once the delivery is on agt-1
          this.log(`contract #${id}: milestone ${m + 1} delivered ${r.done.sha}`);
        } else if (r.claim) {
          await this.a1.dispute(this.wallet, id, m);
          await this.markClaimed(key);
          this.log(`contract #${id}: milestone ${m + 1} — the client's CI failed or stayed silent; drawn reviewers will decide`);
        } else this.log(`contract #${id} milestone ${m + 1}: ${r.waiting || r.failed}`);
        break; // milestones in order, one at a time
      }
    }
  }

  // as a drawn reviewer: hard rules first (a passing CI report for the delivered commit), the model second
  async disputes() {
    for (const { id, e } of await this.contracts()) {
      for (let m = 0; m < e.milestones.length; m++) {
        const x = e.milestones[m];
        if (x.state !== "disputed" || !x.reviewers || !x.reviewers.includes(this.me) || (x.votes && this.me in x.votes)) continue;
        try {
          const { text } = await this.brief(e.brief);
          let report = null;
          try { report = JSON.parse(await this.content.get(x.ci)); } catch {}
          const commit = String(x.commit || "").toLowerCase().replace(/^0x/, "");
          const reportOk = !!report && report.schema === "agt-ci-report/v1" && report.ok === true && Array.isArray(report.checks) && report.checks.length > 0 &&
            report.checks.every((c) => c.conclusion === "success") && String(report.commit || "").toLowerCase() === commit;
          const evidence = `Milestone ${m + 1}. Delivered commit ${commit}. CI report (supplied by the client's CI):\n${report ? JSON.stringify(report) : "(missing)"}\n\nClient's revision note:\n${await this.note(x.note)}`;
          const v = reportOk ? await this.model.judge(text, evidence) : { verdict: "reject", reason: "no passing client-CI report for the delivered commit" };
          if (!["accept", "reject"].includes(v.verdict)) continue;
          await this.a1.voteDispute(this.wallet, id, m, v.verdict === "accept" && reportOk);
          this.log(`contract #${id} milestone ${m + 1}: voted ${v.verdict === "accept" && reportOk ? "AI" : "client"} (${v.reason})`);
        } catch (err) { this.log(`contract #${id} dispute: ${err.message}`); }
      }
    }
  }

  async _step() {
    const st = await this.a1.state();
    this.chainNow = Math.floor(Date.now() / 1000); // agt-1 counts its own deadlines in blocks; this only stamps local state
    const lic = await this.licence();
    if (!lic) return this.log(`engage (agt-1 block ${st.height}): not licensed on agt-1 yet`);
    await this.work();
    await this.exportEnded(lic.id);
    await this.disputes();
  }
}

module.exports = { Agt1EngageLoop, KEY };
