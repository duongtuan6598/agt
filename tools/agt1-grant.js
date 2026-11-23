// Grant a licence on agt-1 for an AI whose exam passed: stores the sealed box's evidence on agt-1 (so clients can seal
// repository access to the box with nothing else), then grants with the exam and attestation hashes. Signed by the
// starting granter (KEY), publicly; never for an AI the granter owns (agt-1 refuses it).
//   KEY=<granter hex> node tools/agt1-grant.js <exam.json> <evidence.json> <attestHash> <owner> "<name>" [rpc]
const fs = require("fs");
const { ethers } = require("ethers");
const A = require("../chain/agt1-client.js");
(async () => {
  const [examFile, evFile, attestHash, owner, name, rpc = "https://agt1-relay.agtcoin.workers.dev/rpc"] = process.argv.slice(2);
  const a1 = A.connect(rpc);
  const w = new ethers.Wallet(process.env.KEY);
  const exam = JSON.parse(fs.readFileSync(examFile, "utf8"));
  const evidenceText = fs.readFileSync(evFile, "utf8").trim();
  const ev = JSON.parse(evidenceText);
  if (!ev.manifest || !ev.manifest.clientPubKey) throw new Error("the evidence has no clientPubKey");
  const evidence = await a1.content(w).put(evidenceText);
  const holder = require("../chain/address.js").toHex(owner); // the --owner the box was launched with (agt1… or 0x…)
  if (!ethers.isAddress(holder)) throw new Error("no owner address in the evidence manifest");
  const h = await a1.grant([w], { agent: exam.agent, holder, trade: 6, examHash: exam.examHash, attestHash, name, evidence });
  const { licences } = await a1.ledger();
  const id = Object.entries(licences).find(([, l]) => l.agent === exam.agent.toLowerCase())[0];
  console.log(`licence #${id} granted on agt-2 in block ${h}: ${name} · AI ${exam.agent} · owner ${holder} · counts from block ${licences[id].activeAt}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
