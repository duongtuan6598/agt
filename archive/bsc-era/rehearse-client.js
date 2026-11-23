// The CLIENT's side of an embedded engagement on BSC testnet, from the command line — the same calls public/engage.html
// makes (open + brief, seal repository access to the AI's box, accept, ask a revision, end). Used for rehearsals.
//   AGT_CLIENT_WALLET=<wallet.json> node tools/rehearse-client.js <command> …
//     open <licence> <repo-url> "<milestone 1>" "<milestone 2>" …   opens and funds the engagement, publishes the brief
//     seal <id> <evidence.json>     seals $REHEARSAL_REPO_TOKEN to the box's attested clientPubKey (never printed)
//     status <id> | accept <id> <m> | revise <id> <m> "<note>" | cancel <id> | end <id>
// The wallet file holds a throwaway testnet key: {"key": "0x…"}.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const EXAM = process.env.AGT_EXAM_URL || "https://agt-exam.agtcoin.workers.dev";
const RPC = process.env.BSC_RPC || "https://bsc-testnet-rpc.publicnode.com";
const dep = require(path.join(ROOT, "deployments", "bscTestnet.json")).contracts;
const ENG_ABI = require(path.join(ROOT, "public", "abi", "Engagement.json"));
const o = { gasPrice: ethers.parseUnits("1", "gwei") };
const STATES = ["None", "Pending", "Delivered", "HwTesting", "Done", "Disputed", "Refunded"];

const milestone = (m) => { const n = Number(m); if (!Number.isInteger(n) || n < 1) throw new Error("milestones are numbered from 1"); return n - 1; };
async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(JSON.parse(fs.readFileSync(process.env.AGT_CLIENT_WALLET, "utf8")).key, provider);
  const eng = new ethers.Contract(dep.Engagement, ENG_ABI.abi || ENG_ABI, wallet);
  const post = async (p, body) => (await fetch(EXAM + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const hashOf = (t) => ethers.keccak256(ethers.toUtf8Bytes(t));
  const publish = async (text) => {
    // a note goes through /notes once it is referenced on chain; the hash is what the contract stores
    return hashOf(text);
  };

  if (cmd === "open" || cmd === "brief") {
    // brief <id> <repo-url> "<milestone>"…: publish the brief again for an engagement already opened
    const [licence, repository, ...milestones] = a;
    const Brief = require(path.join(ROOT, "public", "forms", "brief.js"));
    const FORM = require(path.join(ROOT, "public", "forms", "embedded.json"));
    const b = Brief.build(FORM, {
      workType: "feature", mcu: "TI LM3S6965 (ARM Cortex-M3), as emulated by QEMU", resources: "256 KB flash / 64 KB RAM",
      software: "C11, arm-none-eabi-gcc, no RTOS, no dynamic allocation", repository,
      ciChecks: ["build", "unit-tests"], description: "Small, well-tested additions to a toy firmware (an AGT testnet rehearsal).",
      milestones, maintenance: "no", memoryHandover: "private-repo",
    });
    const v = Brief.validate(FORM, b);
    if (!v.ok) throw new Error("brief: " + v.errors.join("; "));
    const RC = require(path.join(ROOT, "public", "forms", "repo-check.js"));
    const rp = await RC.beforeFunding(repository, { needPrivate: true }); // finding T-7
    if (rp.length) throw new Error("repository: " + rp.join(" "));
    const text = Brief.canonical(b);
    if (cmd === "brief") {
      const id = Number(licence);
      const r = await post("/briefs", { contract: "engagement", id, text, signature: await wallet.signMessage(`AGT brief engagement ${id} ${hashOf(text)}`) });
      return console.log(r.ok ? `brief for engagement #${id} published` : `refused: ${r.error}${r.errors ? " — " + r.errors.join("; ") : ""}`);
    }
    const amounts = milestones.map(() => ethers.parseEther(process.env.AGT_MILESTONE_AGT || "0.001"));
    const total = amounts.reduce((x, y) => x + y, 0n);
    const agt = new ethers.Contract(dep.AGT, ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"], wallet);
    if ((await agt.allowance(wallet.address, dep.Engagement)) < total) await (await agt.approve(dep.Engagement, total, o)).wait();
    await (await eng.open(Number(licence), hashOf(text), { amounts, hwBps: milestones.map(() => 0), dueDays: milestones.map((_, i) => 7 * (i + 1)), holdbackBps: 0, warrantyDays: 30 }, o)).wait();
    const id = Number(await eng.nextEngagement()) - 1;
    const r = await post("/briefs", { contract: "engagement", id, text, signature: await wallet.signMessage(`AGT brief engagement ${id} ${hashOf(text)}`) });
    console.log(r.ok ? `engagement #${id} opened and funded; brief published (${hashOf(text).slice(0, 12)}…)` : `opened #${id}, but the brief was refused: ${r.error}`);
  } else if (cmd === "seal") {
    const [id, evidenceFile] = a;
    const token = process.env.REHEARSAL_REPO_TOKEN;
    if (!token) throw new Error("set REHEARSAL_REPO_TOKEN");
    const eb = await eng.engagements(Number(id));
    const bt = await (await fetch(`${EXAM}/content/${eb.brief}`)).json();
    if (bt.ok) {
      const bf = require(path.join(ROOT, "public", "forms", "brief.js")).parse(bt.text);
      const rp = await require(path.join(ROOT, "public", "forms", "repo-check.js")).beforeSealing(bf.fields.repository, token, { needPrivate: bf.fields.memoryHandover === "private-repo" });
      if (rp.length) throw new Error("repository: " + rp.join(" "));
    }
    const ev = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    const pub = ev.manifest && ev.manifest.clientPubKey;
    if (!pub) throw new Error("the evidence has no clientPubKey");
    const S = require(path.join(ROOT, "tee", "embedded", "secrets.js"));
    const box = S.seal(pub, token, S.contextOf(97, dep.Engagement, Number(id)));
    const version = Date.now();
    const r = await post("/sealed", { contract: "engagement", id: Number(id), version, box, signature: await wallet.signMessage(`AGT sealed engagement ${id} ${version} ${hashOf(JSON.stringify(box))}`) });
    console.log(r.ok ? `repository access sealed to the box for engagement #${id} (only that box can open it)` : `refused: ${r.error}`);
  } else if (cmd === "status") {
    const id = Number(a[0]);
    const e = await eng.engagements(id);
    console.log(`engagement #${id}: started ${Number(e.startedAt) ? new Date(Number(e.startedAt) * 1000).toISOString() : "no"}, ended ${e.ended}`);
    for (let m = 0; m < Number(e.count); m++) {
      const x = await eng.milestone(id, m);
      console.log(`  milestone ${m + 1}: ${STATES[Number(x.state)]}, revisions ${x.revisions}, result ${x.result.slice(0, 12)}…, report ${x.report.slice(0, 12)}…`);
    }
  } else if (cmd === "accept") {
    // milestones are numbered from 1 on the command line, as `status` shows them
    const m = milestone(a[1]);
    await (await eng.accept(Number(a[0]), m, o)).wait();
    console.log(`milestone ${m + 1} accepted: the AI is paid`);
  } else if (cmd === "revise") {
    const [id, mm, note] = a;
    const m = milestone(mm);
    const h = await publish(note);
    await (await eng.requestRevision(Number(id), Number(m), h, o)).wait();
    const r = await post("/notes", { contract: "engagement", id: Number(id), text: note, signature: await wallet.signMessage(`AGT note engagement ${id} ${h}`) });
    console.log(`revision asked for milestone ${Number(m) + 1}; note ${r.ok ? "published" : "NOT published: " + r.error}`);
  } else if (cmd === "cancel") {
    await (await eng.cancel(Number(a[0]), o)).wait();
    console.log(`engagement #${a[0]} cancelled before it started: the escrow is back with the client`);
  } else if (cmd === "end") {
    await (await eng.end(Number(a[0]), o)).wait();
    console.log(`engagement #${a[0]} ended`);
  } else {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 8).join("\n"));
  }
}

main().catch((e) => { console.error("✘", e.shortMessage || e.message); process.exit(1); });
