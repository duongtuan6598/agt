// How the sealed box wires its long-term work (embedded trade). Shared by start.js and the local rehearsal
// (tools/rehearse-local.js), so the rehearsal exercises exactly the production wiring.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..", "..");
const abi = (n) => require(path.join(ROOT, "public", "abi", n + ".json"));

/// Returns an EngageLoop, or null when this image or configuration has no long-term work.
///   env: ENGAGEMENT, MAINTENANCE, AGT_EXAM_URL · wallet: the AI's key on the chain · model: makeModel(…)
///   verifyBuilder: tee/builder/verify-builder.js · dirs: { mem, state, ws } (production: under /var/agt)
///   rehearsal-only knobs: ci (fake CI), allowFileUrls, gitBin — never set by start.js.
async function makeEngage({ env, wallet, model, keys, verifyBuilder, log, dirs = {}, ci, allowFileUrls = false, gitBin }) {
  // AGT's own chain agt-2: contracts, content and sealed access all come from it (docs/decisions/2026-11-22-work-on-agt1.md).
  if (env.AGT1_RPC && keys && fs.existsSync(path.join(ROOT, "tee", "embedded", "agt1-engage.js"))) {
    const { Agt1EngageLoop } = require(path.join(ROOT, "tee", "embedded", "agt1-engage.js"));
    const { fileState } = require(path.join(ROOT, "tee", "embedded", "engage-agent.js"));
    const { RepoMemoryStore } = require(path.join(ROOT, "tee", "embedded", "repo-memory.js"));
    const a1 = require(path.join(ROOT, "chain", "agt1-client.js")).connect(env.AGT1_RPC);
    const key = new ethers.Wallet(wallet.privateKey);
    const memDir = dirs.mem || "/var/agt/memory";
    fs.mkdirSync(memDir, { recursive: true, mode: 0o700 });
    return new Agt1EngageLoop({
      a1, wallet: key, content: a1.content(key), sealed: a1.sealedFor(), model, keys, verifyBuilder, log, ci,
      state: fileState(dirs.state || "/var/agt/state"), wsRoot: dirs.ws || "/var/agt/ws", allowFileUrls, gitBin,
      memStoreFor: ({ kind, id, repository, token }) => new RepoMemoryStore({ dir: path.join(memDir, `${kind}-${id}.git`), url: repository, token, allowFileUrls, git: gitBin }),
    });
  }
  return null; // AGT works on its own chain agt-2 only
}

module.exports = { makeEngage };
