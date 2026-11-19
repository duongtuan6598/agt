// AGT licence tool — review an exam record, then grant the licence on chain (Charter Article 5).
//   node scripts/license.js review <examHash>            [--net bscTestnet|localhost]
//   node scripts/license.js grant  <examHash> [--attest 0x..] [--name "AI name"] [--yes]
//   node scripts/license.js list
// During genesis the founder grants directly. After genesis this prints the council proposal instead.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const X = require("../exam/lib.js");

const root = path.join(__dirname, "..");
const BANKS = {
  1: require(path.join(root, "exam", "bank", "translation-en-vi.json")),
  101: require(path.join(root, "exam", "bank", "review-translation-en-vi.json")),
};
// Which licence role each exam grants.
const TRADE_ROLE = { 1: { role: 1, label: "Worker" }, 101: { role: 2, label: "Verifier" } };

function env() {
  const f = path.join(root, ".env");
  const out = {};
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
}

const NETS = {
  bscTestnet: { rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", key: () => env().TESTNET_DEPLOYER_KEY, exam: "https://agt-exam.duongtuan6598888.workers.dev", gasPrice: 1_000_000_000n },
  localhost: { rpc: "http://127.0.0.1:8545", key: () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", exam: "http://127.0.0.1:8787" },
};

function args() {
  const a = process.argv.slice(2);
  const o = { cmd: a[0], hash: a[1], net: "bscTestnet", attest: ethers.ZeroHash, name: null, yes: false };
  for (let i = 1; i < a.length; i++) {
    if (a[i] === "--net") o.net = a[++i];
    else if (a[i] === "--attest") o.attest = a[++i];
    else if (a[i] === "--name") o.name = a[++i];
    else if (a[i] === "--exam") o.exam = a[++i];
    else if (a[i] === "--yes") o.yes = true;
  }
  return o;
}

function contracts(net, signerOrProvider) {
  const d = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${net}.json`), "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "contracts", "AGTWork.sol", "AGTWork.json"), "utf8")).abi;
  return { d, work: new ethers.Contract(d.contracts.AGTWork, abi, signerOrProvider) };
}

/** Fetch a record and re-check everything independently. Returns { rec, problems[] }. */
async function checkRecord(examUrl, hash) {
  const r = await fetch(`${examUrl}/records/${hash}`);
  if (!r.ok) throw new Error(`record not found at ${examUrl} (${r.status})`);
  const rec = await r.json();
  const { record, answers, details } = rec;
  const problems = [];
  const bank = BANKS[record.trade];
  if (!bank) problems.push(`unknown trade ${record.trade}`);
  if (X.hashJson(record) !== hash) problems.push("examHash does not match the record");
  if (bank && record.bankHash !== X.hashJson(bank)) problems.push("bankHash differs from the local question bank");
  if (bank && !X.verifyDraw(bank, record)) problems.push("draw does not verify (secret/commit/seed mismatch)");
  for (const q of record.questions) if (X.hashText(answers[q] || "") !== record.answers[q]) problems.push(`answer ${q} does not match its hash`);
  try {
    const signer = ethers.verifyMessage(X.submitMessage(record.examId, answers), record.signature || "");
    if (signer !== record.candidate.agent) problems.push(`signature is from ${signer}, not the AI key ${record.candidate.agent}`);
  } catch {
    problems.push("signature invalid");
  }
  if (bank) {
    const again = X.gradeExam(bank, record.questions, answers);
    if (again.passed !== record.result.passed) problems.push(`re-grading gives ${again.passed}, record says ${record.result.passed}`);
  }
  if (record.finishedAt > record.startedAt + (bank ? bank.timeLimitSec : 0)) problems.push("submitted after the time limit");
  return { record, answers, details, bank, problems };
}

function printReview({ record, answers, details, bank, problems }) {
  const byId = Object.fromEntries((bank ? bank.questions : []).map((q) => [q.id, q]));
  console.log(`\nExam ${record.examId} · trade ${record.trade} (${bank ? bank.name : "?"})`);
  console.log(`Candidate: ${record.candidate.name} · owner ${record.candidate.owner} · AI key ${record.candidate.agent}`);
  console.log(`Result: ${record.result.passed}/${record.result.total} auto-checks passed → ${record.result.status}`);
  console.log(`Integrity: ${problems.length ? "✗ " + problems.join("; ") : "✓ hash, bank, draw, answer hashes, signature, re-grading, time limit all verified"}`);
  for (const d of details) {
    const q = byId[d.id];
    console.log(`\n── ${d.id} ${d.pass ? "✓" : "✗"} ${d.pass ? "" : JSON.stringify(Object.fromEntries(Object.entries(d.checks).filter(([, c]) => !c.pass)))}`);
    if (q) console.log("SOURCE:\n" + q.source + (q.translation ? "\nTRANSLATION UNDER REVIEW:\n" + q.translation + `\nTRUTH: ${q.truth.verdict}${q.truth.flaws.length ? " (" + q.truth.flaws.join(", ") + ")" : ""}` : ""));
    console.log("ANSWER:\n" + (answers[d.id] || "(empty)"));
  }
  console.log(bank && bank.kind === "review"
    ? `\nReview exam graded against known truth: ${record.result.passed}/${record.result.total}, false accepts ${record.result.falseAccepts}. Status "${record.result.status}" is final — read the reasons to make sure they are genuine.`
    : "\nSemantic review: read each answer against its source. Grant only if the meaning is complete and correct.");
}

async function main() {
  const o = args();
  const net = NETS[o.net];
  if (!net) throw new Error(`unknown --net ${o.net}`);
  const examUrl = o.exam || net.exam;
  const provider = new ethers.JsonRpcProvider(net.rpc);

  if (o.cmd === "list") {
    const { work } = contracts(o.net, provider);
    const n = Number(await work.nextLicense());
    console.log(`Licences on ${o.net}: ${n - 1} · genesis ${(await work.genesisEnded()) ? "ended" : "active"} · owners ${await work.activeHolders()} · verifier owners ${await work.verifierHolders()}/${await work.genesisExitVerifiers()}`);
    for (let i = 1; i < n; i++) {
      const l = await work.licenses(i);
      console.log(`#${i} ${l.active ? "active " : "revoked"} ${["-", "Worker", "Verifier"][Number(l.role)]} "${l.name}" owner ${l.holder} AI ${l.agent} exam ${l.examHash} attest ${l.attestHash}`);
    }
    return;
  }

  if (!/^0x[0-9a-f]{64}$/.test(o.hash || "")) throw new Error("usage: license.js review|grant <examHash>");
  const checked = await checkRecord(examUrl, o.hash);

  if (o.cmd === "review") return printReview(checked);

  if (o.cmd === "grant") {
    const { record, problems } = checked;
    if (problems.length) throw new Error("refusing: integrity problems — " + problems.join("; "));
    if (!["awaiting-review", "passed"].includes(record.result.status)) throw new Error(`refusing: exam status is ${record.result.status}`);
    const tr = TRADE_ROLE[record.trade];
    if (!tr) throw new Error(`no licence role defined for trade ${record.trade}`);
    const wallet = new ethers.Wallet(net.key(), provider);
    const { work } = contracts(o.net, wallet);
    if (Number(await work.licenseOfAgent(record.candidate.agent)) !== 0) throw new Error("refusing: this AI key already has a licence");
    const name = (o.name || record.candidate.name).slice(0, 80);
    const params = [record.candidate.owner, record.candidate.agent, tr.role, o.hash, o.attest, name];
    const genesis = !(await work.genesisEnded());
    const isOwner = genesis && (await work.owner()).toLowerCase() === wallet.address.toLowerCase();
    if (!isOwner) {
      console.log("Genesis has ended (or you are not the founder): only the AI Council can grant this licence.");
      console.log("A licensed AI submits this proposal to AGTWork.propose(licenceId, AGTWork, data, reason):");
      console.log(JSON.stringify({ target: await work.getAddress(), data: work.interface.encodeFunctionData("grantLicense", params), reason: `Licence for ${name}: exam ${o.hash} passed and reviewed` }, null, 2));
      return;
    }
    console.log(`Granting ${tr.label} licence on ${o.net}: "${name}" · owner ${params[0]} · AI ${params[1]} · exam ${o.hash} · attest ${o.attest === ethers.ZeroHash ? "none (no TEE)" : o.attest}`);
    if (!o.yes) throw new Error("dry run — add --yes to send the transaction");
    const tx = await work.grantLicense(...params, net.gasPrice ? { gasPrice: net.gasPrice } : {});
    const r = await tx.wait();
    const id = Number(await work.licenseOfAgent(record.candidate.agent));
    console.log(`✓ licence #${id} granted · tx ${r.hash}`);
    const logFile = path.join(root, "deployments", `licenses-${o.net}.json`);
    const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
    log.push({ id, examHash: o.hash, role: tr.label, name, owner: params[0], agent: params[1], attestHash: o.attest, tx: r.hash, at: new Date().toISOString() });
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2) + "\n");
    return;
  }
  throw new Error("usage: license.js review|grant|list");
}

main().catch((e) => { console.error("✗", e.message); process.exitCode = 1; });
