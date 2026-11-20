// The sealed AI's long-term work loop for the embedded trade (THIET-KE-NGHE-NHUNG.md). Runs in the embedded box.
//   worker AI   — accept engagements it can do (after reading the brief); for each milestone in order: open the
//                 client's sealed repository token, clone, let the model change the code, run N1–N4 in the sandbox,
//                 retry with the failure log (≤ ROUNDS), push a branch, deliver with the report; same for revision
//                 requests (the client's note), hardware failure logs, warranty claims (deliverFix) and maintenance
//                 incidents (acknowledge at once, fix security incidents, resolve), and the monthly status report.
//   reviewer AI — draw reviewers for open disputes; when drawn, judge the delivery against the brief and vote.
// It never delivers work whose N1–N4 checks fail. Every action is signed with the AI's own key.
const { ethers } = require("ethers");
const Brief = require("../../public/forms/brief.js");
const FORM = require("../../public/forms/embedded.json");
const S = require("./secrets.js");
const { EngagementMemory } = require("./memory.js");
const { Workspace, shaToBytes32 } = require("./workspace.js");

const ROUNDS = 3;

/// What may be published about a delivery: results, hashes and sizes — never raw logs, which can contain the
/// client's private source or secrets (Codex W-7). The full logs stay in the engagement's encrypted memory.
function publicReport(result) {
  const parts = result.parts.map((p) => ({
    level: p.level, check: p.check || null, ok: !!p.ok,
    sha256: p.sha256 || null, warnings: p.warnings ?? null, flash: p.flash ?? null, ram: p.ram ?? null, flashLimit: p.flashLimit ?? null, ramLimit: p.ramLimit ?? null,
    newFindings: Array.isArray(p.newFindings) ? p.newFindings.length : null, missing: Array.isArray(p.missing) ? p.missing.length : null, tampered: Array.isArray(p.tampered) ? p.tampered.length : null,
  }));
  return JSON.stringify({ schema: "agt-n-report/v1", ok: !!result.ok, memoryHead: JSON.parse(result.text).memoryHead || null, parts });
}
const M = { PENDING: 1, DELIVERED: 2, HWTEST: 3, DONE: 4, DISPUTED: 5 };

class EngageLoop {
  // eng, mnt: ethers Contracts connected to the AI's signer · content: {get(hash), put(text)} · sealed: {get(kind,id)}
  // model: {assess, engineer, judge} · tools: tee/embedded/tools.js · keys: E.derive(master) · memStore: memory storage
  constructor({ eng, mnt, me, chainId, content, sealed, model, tools, keys, memStore, wsRoot = "/var/agt/ws", log = () => {}, allowFileUrls = false, gitBin }) {
    Object.assign(this, { eng, mnt, me, chainId, content, sealed, model, tools, keys, memStore, wsRoot, log, allowFileUrls, gitBin });
    this.chainNow = 0;
  }

  /// Deadlines are the CONTRACT's: always compare with the chain's time, never the box's clock.
  now() {
    return this.chainNow;
  }

  async licence() {
    const id = Number(await this.eng.work().then((w) => new ethers.Contract(w, ["function licenseOfAgent(address) view returns (uint256)", "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)"], this.eng.runner).licenseOfAgent(this.me)));
    if (!id) return null;
    const w = new ethers.Contract(await this.eng.work(), ["function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)"], this.eng.runner);
    const l = await w.licenses(id);
    return l.active ? { id, role: Number(l.role), holder: l.holder } : null;
  }

  async brief(hash) {
    const text = await this.content.get(hash);
    const b = Brief.parse(text);
    if (!b || b.form !== `${FORM.id}@${FORM.version}`) throw new Error("not an embedded-trade brief");
    const v = Brief.validate(FORM, b);
    if (!v.ok) throw new Error("invalid brief: " + v.errors.join("; "));
    return { b, text: Brief.render(FORM, b) };
  }

  async note(hash) {
    if (!hash || /^0x0+$/.test(hash)) return "";
    try { return await this.content.get(hash); } catch { return "(the client's note for this hash has not been published)"; }
  }

  memory(kind, id) {
    return new EngagementMemory(this.keys.memory, S.contextOf(this.chainId, kind === "engagement" ? this.eng.target : this.mnt.target, id), this.memStore);
  }

  async token(kind, id) {
    const box = await this.sealed.get(kind, id);
    if (!box) return null;
    try {
      return S.open(this.keys.client.priv, box, S.contextOf(this.chainId, kind === "engagement" ? this.eng.target : this.mnt.target, id));
    } catch (e) {
      this.log(`${kind} #${id}: the sealed access cannot be opened by this box (${e.message}) — ask the client to seal it again`);
      return null;
    }
  }

  // ---------- one piece of work: clone → model → N1–N4 → (retry) → push ----------
  async doWork({ kind, id, branch, b, briefText, task, notes = "" }) {
    const token = await this.token(kind, id);
    if (!token) return { ok: false, why: "the client has not given repository access yet" };
    const ws = new Workspace({ root: this.wsRoot, id: `${kind}-${id}`, allowFileUrls: this.allowFileUrls, git: this.gitBin });
    try {
      return await this._work(ws, { kind, id, branch, b, briefText, task, notes, token });
    } finally {
      ws.dispose(); // no client's code stays where the next build could read it (Codex W-4)
    }
  }

  async _work(ws, { kind, id, branch, b, briefText, task, notes, token }) {
    ws.clone(b.fields.repository, token, branch);
    const mem = this.memory(kind, id);
    const pinned = Object.fromEntries(b.fields.pinnedTests || []);
    let failure = "", result = null, summary = "";
    for (let round = 1; round <= ROUNDS; round++) {
      const { tree, files } = ws.read();
      const a = await this.model.engineer({ brief: briefText, task, notes, memory: await mem.context_(8000), files, tree, failure });
      if (a.cannot) return { ok: false, why: "the AI cannot do this as asked: " + a.cannot };
      if (!a.files.length) { failure = "no files were changed"; continue; }
      try { ws.write(a.files, pinned); } catch (e) { failure = e.message; continue; }
      summary = a.summary;
      result = await this.check(ws.tree, b, await mem.head());
      if (result.ok) break;
      failure = result.parts.filter((p) => !p.ok).map((p) => `${p.level}${p.check ? " " + p.check : ""}: ${(p.log || p.output || (p.newFindings || []).map((f) => `${f.file}:${f.line} ${f.id}`).join("\n") || JSON.stringify(p)).slice(-3000)}`).join("\n\n");
      this.log(`${kind} #${id}: round ${round} failed checks`);
    }
    if (!result || !result.ok) {
      await mem.append("note", `Attempt for "${task.split("\n")[0]}" failed its checks after ${ROUNDS} rounds; not delivered.`);
      return { ok: false, why: "checks still failing after " + ROUNDS + " rounds" };
    }
    const sha = ws.commit(`${task.split("\n")[0]}\n\n${summary}\n\nN1–N4 report: ${result.hash}`);
    ws.push(branch, token);
    const reportHash = await this.content.put(publicReport(result)); // structured results only (Codex W-7)
    const logs = result.parts.map((p) => `${p.level}${p.check ? " " + p.check : ""}: ${String(p.log || p.output || "").slice(-1500)}`).join("\n");
    await mem.append("test", `N1–N4 logs for ${sha}:\n${logs}`);
    await mem.append("delivery", `${task.split("\n")[0]} → ${sha} on ${branch}. ${summary}`);
    return { ok: true, sha, reportHash, summary };
  }

  /// N1–N4 exactly as the brief agreed.
  async check(dir, b, memoryHead) {
    const f = b.fields;
    const pinned = Object.fromEntries(f.pinnedTests || []);
    const parts = [await this.tools.build({ dir, cmd: f.buildCommand, artifact: f.artifact })];
    if (parts[0].ok) {
      const elf = require("path").join(dir, f.artifact);
      if (f.testCommand) parts.push(await this.tools.unitTests({ dir, cmd: f.testCommand, pinned }));
      if (f.simTarget && f.simTarget !== "none") parts.push(await this.tools.simulate({ elf, target: f.simTarget, expect: f.simulation || [] }));
      if (f.flashLimit || f.ramLimit) parts.push(await this.tools.size({ elf, flashLimit: f.flashLimit, ramLimit: f.ramLimit }));
      parts.push(await this.tools.staticAnalysis({ dir }));
    }
    return { ...this.tools.report(parts, { memoryHead }), parts };
  }

  // ---------- engagements ----------
  async engagementsOf(lic) {
    const out = [];
    const n = Number(await this.eng.nextEngagement());
    for (let id = 1; id < n; id++) {
      const e = await this.eng.engagements(id);
      if (Number(e.worker) === lic) out.push({ id, e });
    }
    return out;
  }

  async acceptNew(lic) {
    for (const { id, e } of await this.engagementsOf(lic)) {
      if (Number(e.startedAt) || e.ended) continue;
      try {
        const { text } = await this.brief(e.brief);
        const a = await this.model.assess(text, 7);
        if (!a.feasible) { this.log(`engagement #${id}: not accepted — ${a.reason}`); continue; }
        await (await this.eng.start(id)).wait();
        await this.memory("engagement", id).append("decision", `Accepted the engagement. ${a.reason}`);
        this.log(`engagement #${id}: accepted`);
      } catch (e) { this.log(`engagement #${id}: ${e.message}`); }
    }
  }

  async lastNote(id, m, eventName) {
    const evs = await this.eng.queryFilter(this.eng.filters[eventName](id));
    const mine = evs.filter((x) => Number(x.args.m) === m);
    return mine.length ? this.note(mine[mine.length - 1].args.reason || mine[mine.length - 1].args.log) : "";
  }

  async workEngagements(lic) {
    for (const { id, e } of await this.engagementsOf(lic)) {
      if (!Number(e.startedAt) || e.ended) continue;
      let b, text;
      try { ({ b, text } = await this.brief(e.brief)); } catch (err) { this.log(`engagement #${id}: ${err.message}`); continue; }
      for (let m = 0; m < Number(e.count); m++) {
        const x = await this.eng.milestone(id, m);
        const st = Number(x.state);
        if (st === M.PENDING && Number(x.dueAt) <= this.now()) { this.log(`engagement #${id}: milestone ${m + 1} is overdue — the client may take it back`); break; }
        if (st === M.PENDING) {
          const notes = Number(x.revisions) ? await this.lastNote(id, m, "RevisionRequested") : "";
          const line = (b.fields.milestones || [])[m] || `milestone ${m + 1}`;
          const task = `Milestone ${m + 1} of ${e.count}: ${line}${Number(x.revisions) ? `\n(revision ${x.revisions}: the client's note says what to change)` : ""}`;
          const r = await this.doWork({ kind: "engagement", id, branch: `agt/engagement-${id}-m${m + 1}`, b, briefText: text, task, notes });
          if (r.ok) { await (await this.eng.deliver(id, m, shaToBytes32(r.sha), r.reportHash)).wait(); this.log(`engagement #${id}: milestone ${m + 1} delivered ${r.sha}`); }
          else this.log(`engagement #${id} milestone ${m + 1}: ${r.why}`);
          break; // milestones in order: one at a time
        }
        if (st === M.DONE && Number(x.claimAt) && !Number(x.fixAt) && x.dispute === 0n) {
          const claim = await this.note(x.claim);
          const r = await this.doWork({ kind: "engagement", id, branch: `agt/engagement-${id}-m${m + 1}-warranty`, b, briefText: text, task: `Warranty claim on milestone ${m + 1} (${(b.fields.milestones || [])[m] || ""}): fix the defect the client reports.`, notes: claim });
          if (r.ok) { await (await this.eng.deliverFix(id, m, shaToBytes32(r.sha))).wait(); this.log(`engagement #${id}: warranty fix ${r.sha}`); }
          else this.log(`engagement #${id} warranty: ${r.why}`);
        }
        if (st < M.DONE && st !== M.PENDING) break; // wait for the client before the next milestone
      }
    }
  }

  // ---------- maintenance ----------
  async maintenance(lic) {
    const n = Number(await this.mnt.nextRetainer());
    for (let id = 1; id < n; id++) {
      const r = await this.mnt.retainers(id);
      if (Number(r.worker) !== lic) continue;
      try {
        if (!Number(r.startedAt)) {
          if (r.stopped) continue;
          const { text } = await this.brief(r.brief);
          const a = await this.model.assess(text, 1);
          if (a.feasible) { await (await this.mnt.start(id)).wait(); this.log(`maintenance #${id}: accepted`); }
          continue;
        }
        const { b, text } = await this.brief(r.brief);
        const count = Number(await this.mnt.incidentCount(id));
        for (let i = 0; i < count; i++) {
          const x = await this.mnt.incident(id, i);
          if (!Number(x.ackAt)) { await (await this.mnt.acknowledge(id, i)).wait(); this.log(`maintenance #${id}: incident ${i + 1} acknowledged`); }
          if (!Number(x.fixAt)) {
            const what = await this.note(x.description);
            const w = await this.doWork({ kind: "maintenance", id, branch: `agt/maintenance-${id}-incident-${i + 1}`, b, briefText: text, task: `${Number(x.severity) === 2 ? "SECURITY incident" : "Incident"} ${i + 1}: fix what the client reports.`, notes: what });
            if (w.ok) { await (await this.mnt.resolve(id, i, shaToBytes32(w.sha))).wait(); this.log(`maintenance #${id}: incident ${i + 1} resolved ${w.sha}`); }
          }
        }
        await this.monthlyStatus(id, r, b);
      } catch (e) { this.log(`maintenance #${id}: ${e.message}`); }
    }
  }

  async monthlyStatus(id, r, b) {
    const month = Math.floor((this.now() - Number(r.startedAt)) / (30 * 86400));
    if (month >= Number(r.funded) || (await this.mnt.statusReport(id, month)) !== ethers.ZeroHash) return;
    if (this.now() < Number(r.startedAt) + (month + 1) * 30 * 86400 - 2 * 86400) return; // in the month's last two days
    const token = await this.token("maintenance", id);
    if (!token) return;
    const ws = new Workspace({ root: this.wsRoot, id: `maintenance-${id}-status`, allowFileUrls: this.allowFileUrls, git: this.gitBin });
    let text;
    try {
      ws.clone(b.fields.repository, token, `agt/maintenance-${id}-status`);
      const checks = await this.check(ws.tree, b, await this.memory("maintenance", id).head());
      text = JSON.stringify({ schema: "agt-status/v1", maintenance: id, month: month + 1, recentCommits: ws.log(10).split("\n").filter(Boolean).length, checks: JSON.parse(publicReport(checks)) });
    } finally {
      ws.dispose();
    }
    await (await this.mnt.submitStatus(id, month, await this.content.put(text))).wait();
    this.log(`maintenance #${id}: status report for month ${month + 1}`);
  }

  // ---------- disputes: anyone draws; drawn reviewer AIs judge ----------
  async disputes(lic, isReviewer) {
    const n = Number(await this.eng.nextDispute());
    const block = await this.eng.runner.provider.getBlock("latest");
    for (let d = 1; d < n; d++) {
      const x = await this.eng.disputes(d);
      if (x.closed) continue;
      const max = 2n ** 64n - 1n;
      if (BigInt(x.drawnAt) === max) continue;
      if (BigInt(x.drawnAt) === 0n && block.number > Number(x.seedBlock)) { try { await (await this.eng.drawReviewers(d)).wait(); } catch {} continue; }
      if (BigInt(x.drawnAt) !== 0n && block.timestamp > Number(x.drawnAt) + 2 * 86400) { try { await (await this.eng.drawReviewers(d)).wait(); } catch {} continue; }
      if (!isReviewer || !(await this.eng.drawn(d, x.round, lic))) continue;
      try {
        const id = Number(await this.eng.disputeEngagement(d));
        const m = Number(await this.eng.disputeMilestone(d));
        const e = await this.eng.engagements(id);
        const ms = await this.eng.milestone(id, m);
        const { text } = await this.brief(e.brief);
        const evidence = [
          `Milestone ${m + 1}; dispute kind ${["", "delivery", "hardware", "warranty"][Number(ms.disputeKind)]}.`,
          `Delivered commit ${ms.result}. N1–N4 report:\n${await this.note(ms.report)}`,
          `Client's revision notes:\n${await this.lastNote(id, m, "RevisionRequested")}`,
          `Client's hardware failure log:\n${await this.lastNote(id, m, "HardwareFailure")}`,
          Number(ms.claimAt) ? `Warranty claim:\n${await this.note(ms.claim)}\nFix delivered: ${ms.fix}` : "",
        ].filter(Boolean).join("\n\n");
        // Hard rules first, the model second (Codex W-5): a delivery whose public N1–N4 report is missing,
        // unreadable or failing can never be voted "worker right", whatever the texts say.
        let report = null;
        try { report = JSON.parse(await this.content.get(ms.report)); } catch {}
        const reportOk = !!report && report.schema === "agt-n-report/v1" && report.ok === true && Array.isArray(report.parts) && report.parts.every((p) => p.ok === true);
        const v = reportOk || Number(ms.disputeKind) === 3 ? await this.model.judge(text, evidence) : { verdict: "reject", reason: "the delivery has no passing N1–N4 report" };
        if (!["accept", "reject"].includes(v.verdict)) continue;
        const workerRight = v.verdict === "accept" && (reportOk || Number(ms.disputeKind) === 3);
        await (await this.eng.vote(d, lic, workerRight, `${workerRight ? "worker" : "client"} is right: ${v.reason}`.slice(0, 500))).wait();
        this.log(`dispute #${d}: voted ${workerRight ? "worker" : "client"}`);
      } catch (e) { this.log(`dispute #${d}: ${e.message}`); }
    }
  }

  async step() {
    this.chainNow = Number((await this.eng.runner.provider.getBlock("latest")).timestamp);
    const lic = await this.licence();
    if (!lic) return this.log("engage: not licensed yet");
    if (lic.role === 1) {
      await this.acceptNew(lic.id);
      await this.workEngagements(lic.id);
      await this.maintenance(lic.id);
    }
    await this.disputes(lic.id, lic.role === 2);
  }
}

/// HTTP clients for the exam service's long-term endpoints.
function httpSealed(base) {
  return { async get(kind, id) { const r = await (await fetch(`${base}/sealed/${kind}/${id}`)).json(); return r.ok ? r.box : null; } };
}

module.exports = { EngageLoop, httpSealed, ROUNDS };
