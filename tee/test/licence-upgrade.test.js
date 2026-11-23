// Rules v6: a licence moves to a new sealed box (new model or image, exam sat again) and keeps its number, owner,
// trade and history; the owner must sign; open contracts follow it to the new AI key.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { AGTApp } = require("../../chain/abci/app.js");
const { connectApp } = require("../../chain/agt1-client.js");

const W = (s) => new ethers.Wallet(ethers.id("licence-upgrade-" + s));
const H = (c) => "0x" + c.repeat(32);

function chain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-upg-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  app.views = { name: "none" };
  const granter = W("granter"), client = W("client");
  app.InitChain({ chain_id: "agt-2-test", validators: [], app_state_bytes: Buffer.from(JSON.stringify({
    provisional: true, caretaker: { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [],
    ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [client.address]: (5n * 10n ** 18n).toString(), [granter.address]: (10n ** 18n).toString() }, licenceWait: 1, granter: granter.address },
  })) });
  const jump = (h) => { app.FinalizeBlock({ txs: [], height: String(h), hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } }); app.Commit(); };
  return { app, a1: connectApp(app), granter, client, jump };
}

test("rules v6: an upgrade keeps the licence number and history, needs the owner's signature, and open contracts follow", async () => {
  const { app, a1, granter, client, jump } = chain();
  const oldAi = W("old-ai"), newAi = W("new-ai"), owner = W("owner"), stranger = W("stranger");
  await a1.grant([granter], { agent: oldAi.address, holder: owner.address, trade: 6, examHash: H("11"), attestHash: H("22"), name: "AI" });
  await a1.transfer(client, client.address, 1n);
  const brief = await a1.content(client).put("a brief");
  await a1.openContract(client, 1, brief, [10n ** 18n]);
  const u = { id: 1, agent: newAi.address, examHash: H("33"), attestHash: H("44") };
  await assert.rejects(a1.upgrade([granter], owner, u), /starts with rules v6/, "not before the published height");
  jump(7500);
  await assert.rejects(a1.upgrade([granter], stranger, u), /owner did not sign/, "nobody upgrades someone else's AI");
  await assert.rejects(a1.upgrade([stranger], owner, u), /not signed by those who may sign/, "the owner alone cannot skip the exam check");
  await a1.upgrade([granter], owner, u);
  const l = (await a1.ledger()).licences[1];
  assert.equal(l.agent, newAi.address.toLowerCase(), "the licence now names the new AI");
  assert.equal(l.examHash, H("33"));
  assert.equal(l.holder, owner.address.toLowerCase(), "same owner");
  assert.equal(l.history.length, 1);
  assert.equal(l.history[0].agent, oldAi.address.toLowerCase(), "the old AI is on record");
  assert.equal((await a1.query("/engs"))[1].worker, newAi.address.toLowerCase(), "the open contract follows the licence");
  // the new AI delivers; the old one can no longer act
  await assert.rejects(a1.deliver(oldAi, 1, 0, "0x" + "ab".repeat(20), H("55")));
  await a1.deliver(newAi, 1, 0, "0x" + "ab".repeat(20), H("55"));
  assert.equal((await a1.query("/engs"))[1].milestones[0].state, "delivered");
  await assert.rejects(a1.upgrade([granter], owner, u), /same AI/, "an upgrade must name a new AI");
  assert.equal(Object.keys((await a1.ledger()).licences).length, 1, "still one licence");
});
