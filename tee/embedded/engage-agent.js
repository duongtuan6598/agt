// The sealed AI's long-term work loop for the embedded trade (THIET-KE-NGHE-NHUNG.md; §12 joint decision of
// Claude and Codex: the client's code NEVER runs in the AI's box — the client's own CI runs N1–N4).
//   worker AI   — accept engagements it can do (after reading the brief). For each piece of work (a milestone in
//                 order, a revision, a hardware failure log, a warranty claim, a maintenance incident):
//                 open the client's sealed repository token → clone → the model changes the code → push a branch
//                 → LATER STEPS read the client's CI for that commit: success → deliver (with a public CI report);
//                 failure → the CI's failure text goes back to the model, next round (≤ ROUNDS); silence → wait,
//                 then give up. It never delivers a commit whose required CI checks have not all passed.
//   reviewer AI — draw reviewers for open disputes; when drawn, judge the delivery against the brief and vote.
// Every action is signed with the AI's own key. Steps never block: pending work is kept in `state`.
const { ethers } = require("ethers");
const Brief = require("../../public/forms/brief.js");
const FORM = require("../../public/forms/embedded.json");
const S = require("./secrets.js");
const { EngagementMemory } = require("./memory.js");
const { Workspace, shaToBytes32 } = require("./workspace.js");
const { ciStatus } = require("./forge.js");
const R = require("./builder.js");

const ROUNDS = 3;
const CI_TIMEOUT = 6 * 3600; // seconds without a CI verdict before the attempt is abandoned
const M = { PENDING: 1, DELIVERED: 2, HWTEST: 3, DONE: 4, DISPUTED: 5 };

/// What is published about a delivery: the commit and the client's CI verdicts — evidence SUPPLIED BY THE
/// CLIENT'S CI, not attested by the box (§12). No logs (they may contain private source — Codex W-7).
function ciReport({ sha, branch, ci, memoryHead }) {
  return JSON.stringify({
    schema: "agt-ci-report/v1",
    evidence: "client-ci",
    commit: sha, branch,
    ok: ci.state === "success",
    checks: ci.checks.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
    memoryHead: memoryHead || null,
  });
}

class EngageLoop {
  // eng, mnt: ethers Contracts connected to the AI's signer · content: {get(hash), put(text)} · sealed: {get(kind,id)}
  // model: {assess, engineer, judge} · ci: {status({repository, token, sha, required})} · keys: E.derive(master)
  // memStore: encrypted memory storage · state: {get(key), set(key, value|null)} for pending work
  // repro: {jobs(dispute), postBundle(nonce, sealed)} — the exam service's §14 endpoints (null: no reproduction)
  // verifyBuilder(manifest, evidence) → true only for an approved builder image in a genuine TEE (default: none yet)
  constructor({ eng, mnt, me, chainId, content, sealed, model, ci, keys, memStore, state, repro = null, verifyBuilder = () => false, wsRoot = "/var/agt/ws", log = () => {}, allowFileUrls = false, gitBin }) {
    Object.assign(this, { eng, mnt, me, chainId, content, sealed, model, keys, memStore, state, repro, verifyBuilder, wsRoot, log, allowFileUrls, gitBin });
    this.ci = ci || { status: ciStatus };
    this.chainNow = 0;
  }

  /// Deadlines are the CONTRACT's: always compare with the chain's time, never the box's clock.
  now() {
    return this.chainNow;
  }

  async licence() {
    const w = new ethers.Contract(await this.eng.work(), ["function licenseOfAgent(address) view returns (uint256)", "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)"], this.eng.runner);
    const id = Number(await w.licenseOfAgent(this.me));
    if (!id) return null;
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

  contractOf(kind) {
    return kind === "engagement" ? this.eng.target : this.mnt.target;
  }

  memory(kind, id) {
    return new EngagementMemory(this.keys.memory, S.contextOf(this.chainId, this.contractOf(kind), id), this.memStore);
  }

  async token(kind, id) {
    const box = await this.sealed.get(kind, id);
    if (!box) return null;
    try {
      return S.open(this.keys.client.priv, box, S.contextOf(this.chainId, this.contractOf(kind), id));
    } catch (e) {
      this.log(`${kind} #${id}: the sealed access cannot be opened by this box (${e.message}) — ask the client to seal it again`);
      return null;
    }
  }

  /// One piece of work, advanced one step. Nothing of the client's runs here. Returns
  ///   { done: {sha, reportHash} }  CI passed — the caller delivers, then calls finish(key) (state kept until then: F-4)
  ///   { claim: {sha, evidenceHash} } CI failed after the last round or stayed silent — the caller may ask reviewers
  ///                                  (Engagement.claimDone, §13), then calls markClaimed(key)
  ///   { waiting } / { failed }
  async advance({ key, kind, id, branch, b, briefText, task, notes = "" }) {
    const token = await this.token(kind, id);
    if (!token) return { waiting: "the client has not given repository access yet" };
    const required = b.fields.ciChecks;
    const mem = this.memory(kind, id);
    let st = await this.state.get(key);
    if (st && st.reportHash) return { done: { sha: st.sha, reportHash: st.reportHash } }; // CI passed; delivery not confirmed yet
    if (st && st.evidenceHash) return st.claimed ? { failed: st.gaveUp } : { claim: { sha: st.sha, evidenceHash: st.evidenceHash } };
    if (st && st.gaveUp) return { failed: st.gaveUp };
    if (st && st.sha) {
      const ci = await this.ci.status({ repository: b.fields.repository, token, sha: st.sha, required });
      if (ci.state === "success") {
        const reportHash = await this.content.put(ciReport({ sha: st.sha, branch, ci, memoryHead: await mem.head() }));
        await mem.append("delivery", `${task.split("\n")[0]} → ${st.sha} on ${branch}; client CI passed: ${ci.checks.map((c) => c.name).join(", ")}`);
        await this.state.set(key, { ...st, reportHash });
        return { done: { sha: st.sha, reportHash } };
      }
      let gaveUp = null;
      if (ci.state === "pending") {
        if (this.now() - st.pushedAt < CI_TIMEOUT) return { waiting: `client CI still running for ${st.sha.slice(0, 10)}` };
        gaveUp = `the client's CI gave no verdict for ${st.sha.slice(0, 10)} within ${CI_TIMEOUT / 3600} h`;
      } else if (st.round >= ROUNDS) {
        gaveUp = `client CI still failing after ${ROUNDS} rounds`;
      }
      if (gaveUp) {
        // The client has seen the code; the AI asks drawn reviewers instead of just walking away (§13).
        const evidence = JSON.stringify({ schema: "agt-claim/v1", commit: st.sha, branch, rounds: st.round, reason: gaveUp, ci: { state: ci.state, checks: ci.checks }, history: st.history || [] });
        const evidenceHash = await this.content.put(evidence);
        await this.state.set(key, { ...st, gaveUp, evidenceHash });
        await mem.append("note", `${task.split("\n")[0]}: ${gaveUp}; evidence ${evidenceHash}`);
        return { claim: { sha: st.sha, evidenceHash } };
      }
      // failure → next round with the CI's failure text (untrusted, from the client's CI)
      const history = [...(st.history || []), { round: st.round, commit: st.sha, ci: ci.checks }];
      return this.attempt({ key, kind, id, branch, b, briefText, task, notes, token, mem, round: st.round + 1, failure: ci.failures || "the client's CI reported a failure", history });
    }
    return this.attempt({ key, kind, id, branch, b, briefText, task, notes, token, mem, round: 1, failure: "", history: [] });
  }

  async finish(key) {
    await this.state.set(key, null);
  }

  async markClaimed(key) {
    const st = await this.state.get(key);
    if (st) await this.state.set(key, { ...st, claimed: true });
  }

  async attempt({ key, kind, id, branch, b, briefText, task, notes, token, mem, round, failure, history = [] }) {
    const ws = new Workspace({ root: this.wsRoot, id: `${kind}-${id}`, allowFileUrls: this.allowFileUrls, git: this.gitBin });
    try {
      ws.clone(b.fields.repository, token, branch);
      const { tree, files } = ws.read();
      const a = await this.model.engineer({ brief: briefText, task, notes, memory: await mem.context_(8000), files, tree, failure });
      if (a.cannot) {
        const why = "the AI cannot do this as asked: " + a.cannot;
        await this.state.set(key, { gaveUp: why, round });
        await mem.append("note", `${task.split("\n")[0]}: ${why}`);
        return { failed: why };
      }
      if (!a.files.length) return { waiting: "the model changed nothing; will try again" };
      ws.write(a.files, Object.fromEntries(b.fields.pinnedTests || []));
      const sha = ws.commit(`${task.split("\n")[0]} (round ${round})\n\n${a.summary}`);
      ws.push(branch, token);
      await this.state.set(key, { sha, round, pushedAt: this.now(), history });
      await mem.append("decision", `${task.split("\n")[0]}, round ${round}: pushed ${sha} to ${branch}. ${a.summary}`);
      this.log(`${kind} #${id}: round ${round} pushed ${sha.slice(0, 10)} — waiting for the client's CI`);
      return { waiting: "pushed; the client's CI runs it" };
    } catch (e) {
      this.log(`${kind} #${id}: ${e.message}`);
      return { waiting: e.message };
    } finally {
      ws.dispose();
    }
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
          const rev = Number(x.revisions);
          const notes = rev ? await this.lastNote(id, m, "RevisionRequested") : "";
          const line = (b.fields.milestones || [])[m] || `milestone ${m + 1}`;
          const task = `Milestone ${m + 1} of ${e.count}: ${line}${rev ? `\n(revision ${rev}: the client's note says what to change)` : ""}`;
          const r = await this.advance({ key: `engagement:${id}:m${m}:r${rev}`, kind: "engagement", id, branch: `agt/engagement-${id}-m${m + 1}`, b, briefText: text, task, notes });
          const key = `engagement:${id}:m${m}:r${rev}`;
          if (r.done) {
            await (await this.eng.deliver(id, m, shaToBytes32(r.done.sha), r.done.reportHash)).wait();
            await this.finish(key); // only once the delivery is on chain (Codex F-4)
            this.log(`engagement #${id}: milestone ${m + 1} delivered ${r.done.sha}`);
          } else if (r.claim) {
            if (!(await this.eng.workerClaimed(id, m)) && Number(x.dueAt) > this.now()) {
              await (await this.eng.claimDone(id, m, shaToBytes32(r.claim.sha), r.claim.evidenceHash)).wait();
              this.log(`engagement #${id}: milestone ${m + 1} — the client's CI failed or stayed silent; drawn reviewers will decide`);
            }
            await this.markClaimed(key);
          }
          else this.log(`engagement #${id} milestone ${m + 1}: ${r.waiting || r.failed}`);
          break; // milestones in order: one at a time
        }
        if (st === M.DONE && Number(x.claimAt) && !Number(x.fixAt) && x.dispute === 0n) {
          const claim = await this.note(x.claim);
          const r = await this.advance({ key: `engagement:${id}:m${m}:claim${Number(x.claimAt)}`, kind: "engagement", id, branch: `agt/engagement-${id}-m${m + 1}-warranty`, b, briefText: text, task: `Warranty claim on milestone ${m + 1} (${(b.fields.milestones || [])[m] || ""}): fix the defect the client reports.`, notes: claim });
          if (r.done) { await (await this.eng.deliverFix(id, m, shaToBytes32(r.done.sha))).wait(); await this.finish(`engagement:${id}:m${m}:claim${Number(x.claimAt)}`); this.log(`engagement #${id}: warranty fix ${r.done.sha}`); }
        }
        if ((st < M.DONE && st !== M.PENDING) || st === M.DISPUTED) break; // wait for the client / the reviewers before the next milestone
      }
    }
  }

  // ---------- §14: send the disputed commit to attested builders (worker side) ----------
  async serveReproduction(lic) {
    if (!this.repro) return;
    for (const { id, e } of await this.engagementsOf(lic)) {
      let b;
      for (let m = 0; m < Number(e.count); m++) {
        const x = await this.eng.milestone(id, m);
        if (Number(x.state) !== M.DISPUTED || x.dispute === 0n) continue;
        try {
          b = b || (await this.brief(e.brief)).b;
          const commands = b.fields.reproCommands || [];
          const commit = x.result.slice(2, 42);
          for (const j of await this.repro.jobs(Number(x.dispute))) {
            const mf = j.manifest;
            if (j.hasBundle || j.result || (await this.state.get(`bundle:${mf.nonce}`))) continue;
            if (mf.commit !== commit || R.canonical(mf.commands) !== R.canonical(commands) || !commands.length) continue; // not the disputed work
            if (!this.verifyBuilder(mf, j.evidence)) { this.log(`dispute #${x.dispute}: builder job ${mf.nonce} is not an attested builder — no source sent`); continue; }
            const token = await this.token("engagement", id);
            if (!token) continue;
            const ws = new Workspace({ root: this.wsRoot, id: `repro-${mf.nonce}`, allowFileUrls: this.allowFileUrls, git: this.gitBin });
            try {
              ws.clone(b.fields.repository, token, `agt/engagement-${id}-m${m + 1}`);
              const sealed = R.exportBundle({ gitBin: this.gitBin || "git", gitDir: ws.gitDir, commit, manifest: mf });
              await this.repro.postBundle(mf.nonce, sealed);
              await this.state.set(`bundle:${mf.nonce}`, { sentAt: this.now() });
              this.log(`dispute #${x.dispute}: sent commit ${commit.slice(0, 10)} to builder ${mf.nonce} (sealed to its job key)`);
            } finally {
              ws.dispose();
            }
          }
        } catch (err) { this.log(`engagement #${id} reproduction: ${err.message}`); }
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
            const w = await this.advance({ key: `maintenance:${id}:incident${i}`, kind: "maintenance", id, branch: `agt/maintenance-${id}-incident-${i + 1}`, b, briefText: text, task: `${Number(x.severity) === 2 ? "SECURITY incident" : "Incident"} ${i + 1}: fix what the client reports.`, notes: what });
            if (w.done) { await (await this.mnt.resolve(id, i, shaToBytes32(w.done.sha))).wait(); await this.finish(`maintenance:${id}:incident${i}`); this.log(`maintenance #${id}: incident ${i + 1} resolved ${w.done.sha}`); }
          }
        }
        await this.monthlyStatus(id, r, b);
      } catch (e) { this.log(`maintenance #${id}: ${e.message}`); }
    }
  }

  /// The monthly status: the client's CI verdict on the default branch head, and recent activity (no build here).
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
      const head = ws.log(1).split(" ")[0];
      const full = ws._git(["rev-parse", "HEAD"]).trim();
      const ci = await this.ci.status({ repository: b.fields.repository, token, sha: full, required: b.fields.ciChecks });
      text = JSON.stringify({ schema: "agt-status/v1", maintenance: id, month: month + 1, head, recentCommits: ws.log(10).split("\n").filter(Boolean).length, ci: { state: ci.state, checks: ci.checks }, evidence: "client-ci" });
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
        // Hard rules first, the model second (Codex W-5): a delivery whose public CI report is missing, unreadable,
        // failing, or not about the delivered commit can never be voted "worker right". The CI report is evidence
        // supplied by the client's CI (§12) — independent reproduction by reviewers' disposable builders is step 2.
        let report = null;
        try { report = JSON.parse(await this.content.get(ms.report)); } catch {}
        const reportOk = !!report && report.schema === "agt-ci-report/v1" && report.ok === true && Array.isArray(report.checks) && report.checks.length > 0 &&
          report.checks.every((c) => c.conclusion === "success") && shaToBytes32(String(report.commit || "")) === ms.result;
        const evidence = [
          `Milestone ${m + 1}; dispute kind ${["", "delivery", "hardware", "warranty", "worker's claim (the client's CI failed or stayed silent)"][Number(ms.disputeKind)]}.`,
          `Delivered commit ${ms.result}. CI report (evidence supplied by the client's CI, not attested by any box):\n${report ? JSON.stringify(report) : "(missing)"}`,
          `Client's revision notes:\n${await this.lastNote(id, m, "RevisionRequested")}`,
          `Client's hardware failure log:\n${await this.lastNote(id, m, "HardwareFailure")}`,
          Number(ms.claimAt) ? `Warranty claim:\n${await this.note(ms.claim)}\nFix delivered: ${ms.fix}` : "",
        ].filter(Boolean).join("\n\n");
        // §14: independent reproductions on attested builders (evidence, not an oracle)
        let repro = "none";
        const reproNotes = [];
        if (this.repro) {
          const commands = ((await this.brief(e.brief)).b.fields.reproCommands) || [];
          const verdicts = [];
          for (const j of await this.repro.jobs(d)) {
            if (!j.result) continue;
            const v = R.verifyResult({ job: { manifest: j.manifest }, result: j.result.result, signature: j.result.signature, evidence: j.evidence, dispute: d, commitBytes32: ms.result, commands, verifyAttestation: this.verifyBuilder });
            reproNotes.push(`builder ${j.manifest.nonce}: ${v.valid ? v.why : "ignored — " + v.why}`);
            if (v.valid) verdicts.push(v.ok);
          }
          repro = !verdicts.length ? "none" : verdicts.every(Boolean) ? "pass" : verdicts.every((x) => !x) ? "fail" : "inconclusive";
        }
        const warranty = Number(ms.disputeKind) === 3;
        // A worker's claim (§13): until reviewers can reproduce checks on disposable builders (step 2), only a claim
        // over a SILENT client CI is weighed on its merits; a claim over a FAILING CI goes to the client.
        const claimSilent = Number(ms.disputeKind) === 4 && !!report && report.schema === "agt-claim/v1" && report.ci && report.ci.state === "pending" &&
          shaToBytes32(String(report.commit || "")) === ms.result;
        const claimFailingReproduced = Number(ms.disputeKind) === 4 && repro === "pass"; // §14: a reproduction can overrule a failing client CI
        // R-4: a reproduction is evidence, not an oracle — a verified failure goes to the judgement with everything
        // else; only a worker's claim over a FAILING client CI with no passing reproduction stays with the client.
        const weigh = reportOk || warranty || claimSilent || claimFailingReproduced;
        const allEvidence = `${evidence}\n\nIndependent reproductions on attested builders (§14): ${repro}\n${reproNotes.join("\n")}`;
        const v = weigh ? await this.model.judge(text, allEvidence) : { verdict: "reject", reason: "no passing client-CI report and no passing reproduction for the delivered commit" };
        if (!["accept", "reject"].includes(v.verdict)) continue;
        const workerRight = v.verdict === "accept" && weigh;
        await (await this.eng.vote(d, lic, workerRight, `${workerRight ? "worker" : "client"} is right: ${v.reason}`.slice(0, 500))).wait();
        this.log(`dispute #${d}: voted ${workerRight ? "worker" : "client"}`);
      } catch (e) { this.log(`dispute #${d}: ${e.message}`); }
    }
  }

  async step() {
    if (this.running) return this.log("engage: previous step still running"); // one writer of state/branches (Codex F-3)
    this.running = true;
    try {
      await this._step();
    } finally {
      this.running = false;
    }
  }

  async _step() {
    this.chainNow = Number((await this.eng.runner.provider.getBlock("latest")).timestamp);
    const lic = await this.licence();
    if (!lic) return this.log("engage: not licensed yet");
    if (lic.role === 1) {
      await this.serveReproduction(lic.id);
      await this.acceptNew(lic.id);
      await this.workEngagements(lic.id);
      await this.maintenance(lic.id);
    }
    await this.disputes(lic.id, lic.role === 2);
  }
}

/// HTTP client for the §14 reproduction endpoints; bundles are signed with the AI's key.
function httpRepro(base, wallet) {
  return {
    async jobs(dispute) { const r = await (await fetch(`${base}/repro/jobs?dispute=${dispute}`)).json(); return r.ok ? r.jobs : []; },
    async postBundle(nonce, sealed) {
      const text = JSON.stringify(sealed);
      const signature = await wallet.signMessage(`AGT repro bundle ${nonce} ${ethers.keccak256(ethers.toUtf8Bytes(text))}`);
      const r = await (await fetch(`${base}/repro/${nonce}/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed, signature }) })).json();
      if (!r.ok) throw new Error("sending the bundle: " + r.error);
    },
  };
}

/// HTTP clients for the exam service's long-term endpoints.
function httpSealed(base) {
  return { async get(kind, id) { const r = await (await fetch(`${base}/sealed/${kind}/${id}`)).json(); return r.ok ? r.box : null; } };
}

/// Pending-work state on the box's disk (root-only): which commit is waiting for which CI, which round.
function fileState(dir) {
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = (k) => path.join(dir, k.replace(/[^\w:.-]/g, "_") + ".json");
  return {
    get: async (k) => (fs.existsSync(f(k)) ? JSON.parse(fs.readFileSync(f(k), "utf8")) : null),
    set: async (k, v) => {
      if (v === null) return fs.rmSync(f(k), { force: true });
      const tmp = f(k) + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
      fs.renameSync(tmp, f(k)); // atomic replace
    },
  };
}

module.exports = { EngageLoop, httpSealed, httpRepro, fileState, ciReport, ROUNDS, CI_TIMEOUT };
