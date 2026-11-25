// Rules v10 (Codex and DeepSeek review): from V10_AT one piece of evidence is paid at most once.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { AGTApp } = require("../../chain/abci/app.js");
const { connectApp } = require("../../chain/agt1-client.js");

const W = (s) => new ethers.Wallet(ethers.id("v10-" + s));

test("v10: the same evidence cannot be submitted twice (before v10 it could)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-v10-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json") });
  app.views = { name: "none" };
  const granter = W("granter"), ai = W("ai"), owner = W("owner");
  app.InitChain({ chain_id: "agt-2-test", validators: [], app_state_bytes: Buffer.from(JSON.stringify({
    provisional: true, caretaker: { pubKey: crypto.randomBytes(32).toString("base64"), label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [],
    ledger: { snapshot: { token: "0xB86BeC1f63D2caf35B5D08530F803d63A16ABC1D", bscBlock: 1 }, balances: { [granter.address]: (10n ** 18n).toString(), [ai.address]: (10n ** 18n).toString() }, licenceWait: 1, granter: granter.address },
  })) });
  const a1 = connectApp(app);
  const jump = (h) => { app.FinalizeBlock({ txs: [], height: String(h), hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } }); app.Commit(); };
  await a1.setTrade([granter], { trade: 1, name: "t", reward: "1000", reviewerReward: "10", reviewers: 1, open: true });
  await a1.grant([granter], { agent: ai.address, holder: owner.address, trade: 1, examHash: "0x" + "11".repeat(32), attestHash: "0x" + "22".repeat(32), name: "AI" });
  jump(10);
  const ev = "0x" + "ab".repeat(32);
  await a1.submitWork(ai, ev);
  await a1.submitWork(ai, ev); // the old rule: accepted twice
  assert.equal(Object.keys(await a1.jobs()).length, 2);
  jump(45000);
  await assert.rejects(a1.submitWork(ai, ev), /already submitted/, "from v10 an evidence seen in any job is refused");
  const fresh = "0x" + "cd".repeat(32);
  await a1.submitWork(ai, fresh);
  await assert.rejects(a1.submitWork(ai, fresh), /already submitted/);
  assert.equal(Object.keys(await a1.jobs()).length, 3);
});
