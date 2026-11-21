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
  const engagePath = path.join(ROOT, "tee", "embedded", "engage-agent.js");
  if (!(env.ENGAGEMENT && env.MAINTENANCE && keys && fs.existsSync(engagePath))) return null;
  const { EngageLoop, httpSealed, httpRepro, fileState } = require(engagePath);
  const { RepoMemoryStore } = require(path.join(ROOT, "tee", "embedded", "repo-memory.js"));
  const { httpContent } = require("./agent.js");
  const exam = env.AGT_EXAM_URL || "https://agt-exam.agtcoin.workers.dev";
  const memDir = dirs.mem || "/var/agt/memory";
  fs.mkdirSync(memDir, { recursive: true, mode: 0o700 });
  return new EngageLoop({
    eng: new ethers.Contract(env.ENGAGEMENT, abi("Engagement"), wallet),
    mnt: new ethers.Contract(env.MAINTENANCE, abi("Maintenance"), wallet),
    me: wallet.address,
    chainId: Number((await wallet.provider.getNetwork()).chainId),
    content: httpContent(exam, wallet),
    sealed: httpSealed(exam),
    repro: httpRepro(exam, wallet),
    model, keys, verifyBuilder, log, ci,
    state: fileState(dirs.state || "/var/agt/state"),
    wsRoot: dirs.ws || "/var/agt/ws",
    allowFileUrls, gitBin,
    // memory (§16): ciphertext in the client's own repository, branch agt/memory; the key comes back by escrow,
    // so a replaced VM reads it all again. The local git dir is only a cache.
    memStoreFor: ({ kind, id, repository, token }) => new RepoMemoryStore({ dir: path.join(memDir, `${kind}-${id}.git`), url: repository, token, allowFileUrls, git: gitBin }),
  });
}

module.exports = { makeEngage };
