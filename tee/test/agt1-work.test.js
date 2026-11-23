// Per-job work on agt-2 (tee/box/agt1-work.js) against an in-process agt-2 app: a translation AI submits, AIs of
// other owners are drawn and vote, the work is minted to the worker's owner. Signatures in AGT's own form.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { AGTApp } = require("../../chain/abci/app.js");
const { connectApp } = require("../../chain/agt1-client.js");
const { Agt1WorkLoop } = require("../box/agt1-work.js");

const W = (s) => new ethers.Wallet(ethers.id("agt1-work-" + s));
const TASKS = [{ id: "doc-1", title: "A", source: "Hello world" }, { id: "doc-2", title: "B", source: "Good morning" }];

function chain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt1-work-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  app.views = { name: "none" };
  const granter = W("granter");
  const rich = Object.fromEntries([W("granter"), ...[0, 1, 2].map((i) => W("ai" + i))].map((w) => [w.address, (10n ** 18n).toString()]));
  app.InitChain({ chain_id: "agt-2-test", validators: [], app_state_bytes: Buffer.from(JSON.stringify({
    provisional: true, caretaker: { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [],
    ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: rich, licenceWait: 1, granter: granter.address },
  })) });
  return { app, a1: connectApp(app), granter };
}
const lic = (k, holder) => ({ agent: k.address, holder: holder.address, trade: 1, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "AI" });

test("translation on agt-2: the AI submits evidence on chain, drawn AIs of other owners review and vote, the owner is paid", async () => {
  const { app, a1, granter } = chain();
  const ais = [0, 1, 2].map((i) => ({ key: W("ai" + i), owner: W("owner" + i) }));
  await a1.setTrade([granter], { trade: 1, name: "Open-document translation", reward: "500000000000000", reviewerReward: "50000000000000", reviewers: 2, open: true });
  for (const x of ais) await a1.grant([granter], lic(x.key, x.owner));
  const model = { translate: async (t) => "VI: " + t.source, review: async (t, text) => ({ verdict: text === "VI: " + t.source ? "accept" : "reject", reason: "checked" }) };
  for (const t of TASKS) await a1.postTask(granter, { trade: 1, ...t }); // the open tasks live on agt-2
  assert.equal((await a1.tasks(1)).length, 2);
  const loops = ais.map((x) => new Agt1WorkLoop({ a1, wallet: x.key, tasks: () => a1.tasks(1), model }));
  const h = await loops[0].workerStep(await loops[0].licence());
  assert.ok(h, "submitted");
  const ev = JSON.parse(await a1.content(ais[0].key).get(h));
  assert.equal(ev.task, (await a1.tasks(1)).find((t) => t.title === "A").id, "the task is named by its hash on agt-2");
  for (let i = 0; i < 4; i++) await a1.content(granter).put("tick " + i); // blocks pass: reviewers are drawn
  const job = Object.values(await a1.jobs())[0];
  assert.equal(job.status, "drawn");
  assert.ok(!job.reviewers.includes(ais[0].key.address.toLowerCase()), "never its own owner's AI");
  for (const l of loops.slice(1)) await l.reviewStep(await l.licence());
  const done = Object.values(await a1.jobs())[0];
  assert.equal(done.status, "accepted");
  // the next task is a new one, never the one already submitted
  const h2 = await loops[0].workerStep(await loops[0].licence());
  assert.equal(JSON.parse(await a1.content(ais[0].key).get(h2)).task, (await a1.tasks(1)).find((t) => t.title === "B").id);
  assert.ok(app.state.supply > 0n);
});
