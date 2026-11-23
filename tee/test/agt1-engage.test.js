// The embedded AI's work loop on agt-1 (tee/embedded/agt1-engage.js), against an in-process agt-1 app: licence,
// contract, content and sealed access all on agt-1; delivery, dispute and reviewer vote as agt-1 transactions.
// The chain-free core (model, git, CI, memory: EngageLoop.advance) has its own tests; here it is stubbed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { AGTApp } = require("../../chain/abci/app.js");
const { connectApp } = require("../../chain/agt1-client.js");
const { Agt1EngageLoop } = require("../embedded/agt1-engage.js");

const W = (s) => new ethers.Wallet(ethers.id("agt1-engage-" + s));

function chain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt1-eng-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  app.views = { name: "none" };
  const granter = W("granter"), client = W("client"), ai = W("ai"), owner = W("owner"), rev = W("rev"), revOwner = W("rev-owner");
  app.InitChain({ chain_id: "agt-1-test", validators: [], app_state_bytes: Buffer.from(JSON.stringify({
    provisional: true, caretaker: { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [],
    ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [client.address]: (5n * 10n ** 18n).toString() }, licenceWait: 1, granter: granter.address },
  })) });
  return { app, a1: connectApp(app), granter, client, ai, owner, rev, revOwner };
}

const lic = (k, holder) => ({ agent: k.address, holder: holder.address, trade: 6, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "AI" });
const loopFor = (a1, wallet, over = {}) => {
  const l = new Agt1EngageLoop({ a1, wallet, content: a1.content(wallet), sealed: a1.sealedFor(), model: over.model || {}, ci: {}, keys: { memory: Buffer.alloc(32), client: {} }, state: { m: {}, async get(k) { return this.m[k] || null; }, async set(k, v) { this.m[k] = v; } }, log: () => {} });
  l.brief = async () => ({ b: { fields: { milestones: ["do it", "do more"] } }, text: "brief" });
  return Object.assign(l, over);
};

test("the AI finds its contract on agt-1, delivers through agt-1, and the client pays it — no BSC anywhere", async () => {
  const { app, a1, granter, client, ai, owner } = chain();
  await a1.grant([granter], lic(ai, owner));
  await a1.state(); await a1.transfer(client, client.address, 1n); await a1.transfer(client, client.address, 1n); // pass the licence wait
  const brief = await a1.content(client).put("a brief for the AI");
  await a1.openContract(client, 1, brief, [10n ** 18n, 2n * 10n ** 18n]);
  const report = await a1.content(ai).put(JSON.stringify({ schema: "agt-ci-report/v1", ok: true, commit: "ab".repeat(20), checks: [{ name: "build", conclusion: "success" }], memoryHead: "genesis" }));
  const loop = loopFor(a1, ai, { advance: async () => ({ done: { sha: "ab".repeat(20), reportHash: report } }) });
  await loop.step();
  let e = (await a1.query("/engs"))[1];
  assert.equal(e.milestones[0].state, "delivered");
  assert.equal(e.milestones[0].ci, report, "the CI report hash is on agt-1, and the report itself too");
  assert.equal(await loop.memoryAnchor("engagement", 1), "genesis", "the memory anchor is read back from agt-1");
  await a1.accept(client, 1, 0);
  e = (await a1.query("/engs"))[1];
  assert.equal(e.milestones[0].state, "paid");
  assert.equal((await a1.balance(owner.address)).balance, 10n ** 18n);
  assert.equal(app.state.licences[1].active, true);
});

test("a drawn reviewer votes on agt-1: a delivery without a passing CI report for its commit goes to the client", async () => {
  const { a1, granter, client, ai, owner, rev, revOwner } = chain();
  await a1.grant([granter], lic(ai, owner));
  await a1.grant([granter], lic(rev, revOwner));
  await a1.transfer(client, client.address, 1n); await a1.transfer(client, client.address, 1n);
  const brief = await a1.content(client).put("brief 2");
  await a1.openContract(client, 1, brief, [10n ** 18n]);
  const bad = await a1.content(ai).put(JSON.stringify({ schema: "agt-ci-report/v1", ok: false, commit: "cd".repeat(20), checks: [{ name: "build", conclusion: "failure" }] }));
  await a1.deliver(ai, 1, 0, "0x" + "cd".repeat(20), bad);
  await a1.dispute(client, 1, 0);
  for (let i = 0; i < 4; i++) await a1.transfer(client, client.address, 1n); // blocks for the draw
  const x = (await a1.query("/engs"))[1].milestones[0];
  assert.ok(x.reviewers.includes(rev.address.toLowerCase()), "the licensed AI of another owner is drawn");
  assert.ok(x.reviewers.includes(granter.address.toLowerCase()), "too few owners yet: the starting granter fills a seat, publicly and unpaid");
  const reviewer = loopFor(a1, rev, { model: { judge: async () => ({ verdict: "accept", reason: "model says fine" }) } });
  await reviewer.disputes();
  await a1.voteDispute(granter, 1, 0, false);
  const after = (await a1.query("/engs"))[1].milestones[0];
  assert.equal(after.state, "refunded", "hard rule first: a failing CI report is never voted 'AI right', whatever the model says");
});
