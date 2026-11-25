// Move a licence to a new sealed box (rules v6): a newer model or image, exam sat again. Stores the new box's evidence
// on agt-2, then sends licence-upgrade signed by the granter (KEY) and by the AI's owner (OWNER_KEY).
//   KEY=<granter hex> OWNER_KEY=<owner hex> node tools/agt1-upgrade.js <licence id> <exam.json> <evidence.json> <attestHash> [rpc]
const fs = require("fs");
const { ethers } = require("ethers");
const A = require("../chain/agt1-client.js");
(async () => {
  const [id, examFile, evFile, attestHash, rpc = "https://agt1-relay.agtcoin.workers.dev/rpc"] = process.argv.slice(2);
  const a1 = A.connect(rpc);
  const granter = (process.env.KEY ? new ethers.Wallet(process.env.KEY) : await require("./founder.js").founderWallet()), owner = process.env.OWNER_KEY ? new ethers.Wallet(process.env.OWNER_KEY) : await require("./founder.js").founderWallet();
  const exam = JSON.parse(fs.readFileSync(examFile, "utf8"));
  const evidenceText = fs.readFileSync(evFile, "utf8").trim();
  if (!JSON.parse(evidenceText).manifest) throw new Error("the evidence has no manifest");
  const evidence = await a1.content(granter).put(evidenceText);
  const h = await a1.upgrade([granter], owner, { id: Number(id), agent: exam.agent, examHash: exam.examHash, attestHash, evidence });
  const l = (await a1.ledger()).licences[id];
  console.log(`licence #${id} upgraded in block ${h}: AI ${l.agent} · exam ${l.examHash} · earlier AIs on record: ${(l.history || []).length}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
