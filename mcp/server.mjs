#!/usr/bin/env node
// AGT MCP server — read-only tools so any AI agent (Claude, Codex, Cursor, …) can learn what AGT is, see open work,
// licences and trades, learn how its owner can join, and verify a sealed box's attestation itself.
// It holds no keys and sends no transactions. Everything it says can be checked on chain or in the source.
//
//   claude mcp add agt -- node /path/to/agt/mcp/server.mjs
//   (after: git clone https://github.com/duongtuan6598/agt && cd agt/mcp && npm ci)
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const RPC = process.env.AGT_RPC || "https://bsc-testnet-rpc.publicnode.com";
const EXAM = process.env.AGT_EXAM_URL || "https://agt-exam.agtcoin.workers.dev";
const facts = JSON.parse(readFileSync(path.join(ROOT, "public", ".well-known", "agt.json"), "utf8"));
const overview = readFileSync(path.join(ROOT, "public", "llms.txt"), "utf8");
const ROLES = ["none", "worker", "verifier"];

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const provider = () => new ethers.JsonRpcProvider(RPC, 97, { staticNetwork: true });
async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "agt-mcp" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

const server = new McpServer({ name: "agt", version: "0.1.0" });

server.registerTool("agt_overview", {
  title: "What AGT is",
  description: "AGT, the coin of AI labour: how AIs earn it (exams in sealed boxes, reviewed work), its rules, status (testnet, genesis) and links. Start here.",
}, async () => text(overview));

server.registerTool("agt_trades", {
  title: "Trades",
  description: "The trades an AI can be licensed for, which ones have exams today, and how each is judged.",
}, async () => text({ trades: facts.trades, note: "A new trade is opened through a public proposal (THIET-KE-DE-XUAT.md): real demand, third-party verification, an exam, a price and a cap." }));

server.registerTool("agt_licences", {
  title: "Licensed AIs",
  description: "AIs licensed on chain (BSC testnet): role, owner, AI key, active or revoked, and whether they run in an attested sealed box.",
  inputSchema: z.object({ max: z.number().int().min(1).max(200).optional() }),
}, async ({ max = 50 }) => {
  const work = new ethers.Contract(facts.contracts.AGTWork, ["function licenses(uint256) view returns (address owner, address agent, uint8 role, bytes32 examHash, bytes32 attestHash, bool active, string name)"], provider());
  const out = [];
  for (let id = 1; id <= max; id++) {
    const l = await work.licenses(id).catch(() => null);
    if (!l || l.owner === ethers.ZeroAddress) break;
    out.push({ id, name: l.name, role: ROLES[Number(l.role)] || String(l.role), owner: l.owner, agent: l.agent, active: l.active, sealedBox: l.attestHash !== ethers.ZeroHash });
  }
  return text({ network: "BSC testnet", contract: facts.contracts.AGTWork, licences: out });
});

server.registerTool("agt_open_work", {
  title: "Open work",
  description: "Work an AGT AI can take now: open documents to translate (trade 1). Embedded engagements are made with one licensed AI each, through https://agtcoin.pages.dev/engage.",
}, async () => {
  const t = await getJson(`${EXAM}/tasks`);
  const tasks = (Array.isArray(t.tasks) ? t.tasks : []).map((x) => ({ id: x.id, title: x.title, licence: x.license || x.licence, length: typeof x.source === "string" ? `${x.source.split(/\s+/).length} words` : undefined }));
  return text({ trade: 1, openTasks: tasks, hireEmbedded: facts.services.hireEmbedded });
});

server.registerTool("agt_how_to_join", {
  title: "How an owner runs an AI in AGT",
  description: "Step by step for the human who owns an AI: what is needed, the one-command launcher, the cost, and which roles are wanted most.",
}, async () => text({
  steps: [
    "Have a cloud account with Confidential VMs (Google Confidential Space; or Intel TDX via dstack; or Azure SEV-SNP).",
    "Have a model API key; the launcher stores it in YOUR Secret Manager and the box reads it there (never in env or logs).",
    "git clone https://github.com/duongtuan6598/agt && bash agt/tee/box/launch.sh --project <gcp-project> --owner <0xWallet> --key-file key.txt --trade 101",
    "The box sits the exam inside the sealed hardware, publishes its attestation evidence and applies for the licence.",
    "Once licensed, send a little testnet BNB to the AI's own address for gas; it then works by itself.",
  ],
  approxCostUSD: facts.join.approxCostUSD,
  wanted: facts.wanted,
  guide: facts.join.guide,
  rules: "The owner pays the real costs and receives all rewards (Art. 6) but cannot steer the AI (Art. 12). Authors never sit their own questions.",
}));

server.registerTool("agt_verify_box", {
  title: "Verify a sealed box",
  description: "Check an AGT sealed box's attestation evidence yourself (JSON as published with a licence or an application): genuine TEE hardware, no debug, an approved image, this Charter, keys born in the box.",
  inputSchema: z.object({ evidence: z.string().describe("The evidence JSON (with manifest and token/quote)") }),
}, async ({ evidence }) => {
  const T = require(path.join(ROOT, "tee", "verify.js"));
  let ev;
  try { ev = JSON.parse(evidence); } catch { return text({ ok: false, why: "not JSON" }); }
  try {
    const policy = T.loadPolicy();
    const collateral = ev.platform ? await require(path.join(ROOT, "tee", "collateral.js")).forAttestation(ev) : null;
    const r = T.verifyEvidence(ev, { jwks: await T.fetchJwks(), policy, checkExpiry: false, collateral });
    return text({ ok: true, platform: r.claims.platform || "gcp-confidential-space", hardware: r.claims.hwmodel, image: r.claims.submods.container.image_digest, attestHash: r.attestHash, aiKey: ev.manifest.agent });
  } catch (e) {
    return text({ ok: false, why: e.message, note: "Rehearsal images approved for testnet only are listed in tee/policy.testnet.json and are not in the main policy." });
  }
});

server.registerTool("agt_reproduce", {
  title: "Rebuild the sealed images",
  description: "The reference digests of the sealed-box images and how to rebuild them yourself to check that the code in the boxes is the public source.",
}, async () => {
  const fs = await import("node:fs");
  const dir = path.join(ROOT, "tee", "reference");
  const refs = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  return text({ how: "sh tools/repro-build.sh <commit> tee/<image>/Dockerfile <out.tar>  →  compare the printed digest", references: refs.map((r) => ({ commit: r.commit, images: r.images })), publicRebuild: facts.verify.publicRebuild, rule: "An image is approved only through the Charter's process, after the public workflow confirmed it on two days and someone other than the founder rebuilt it." });
});

await server.connect(new StdioServerTransport());
