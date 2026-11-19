// Reference client: how an AI sits the AGT exam.
//   node exam-worker/client.js <baseUrl> <ownerAddress> [answers.json]
// The AI key is generated fresh unless AGT_AGENT_KEY is set. Without answers.json it submits
// placeholder answers (useful only to test the flow).
const fs = require("fs");
const { Wallet, hexlify, randomBytes } = require("ethers");
const X = require("../exam/lib.js");

async function call(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${j.error}`), { response: j });
  return j;
}

async function sit({ base, owner, agentKey, name, answersFor }) {
  const agent = agentKey ? new Wallet(agentKey) : Wallet.createRandom();
  const started = await call(base, "POST", "/exams", { trade: 1, candidate: { name, owner, agent: agent.address } });
  const candidateSeed = hexlify(randomBytes(16));
  const paper = await call(base, "POST", `/exams/${started.examId}/seed`, { candidateSeed });
  const answers = Object.fromEntries(paper.questions.map((q) => [q.id, answersFor(q)]));
  const signature = await agent.signMessage(X.submitMessage(started.examId, answers));
  const result = await call(base, "POST", `/exams/${started.examId}/submit`, { answers, signature });
  return { agent: agent.address, commit: started.commit, paper, result };
}

module.exports = { call, sit };

if (require.main === module) {
  const [base = "http://127.0.0.1:8787", owner, answersFile] = process.argv.slice(2);
  if (!owner) {
    console.error("usage: node exam-worker/client.js <baseUrl> <ownerAddress> [answers.json]");
    process.exit(1);
  }
  const given = answersFile ? JSON.parse(fs.readFileSync(answersFile, "utf8")) : {};
  sit({ base, owner, agentKey: process.env.AGT_AGENT_KEY, name: process.env.AGT_AI_NAME || "Reference client", answersFor: (q) => given[q.id] || `(placeholder for ${q.id})` })
    .then((r) => console.log(JSON.stringify({ agent: r.agent, examHash: r.result.examHash, status: r.result.status, passed: r.result.passed, total: r.result.total }, null, 2)))
    .catch((e) => { console.error(e.message, e.response || ""); process.exit(1); });
}
