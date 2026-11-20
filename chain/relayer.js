// AGT relayer — carries withdrawals from the AGT chain to AGTBridge.release() on BSC.
// It holds NO privileged key: the AIs' signatures decide everything, the AGT always goes to the
// signed recipient, and if two relayers race, the second one simply finds it already released.
// The relayer only pays BSC gas. Usually the person withdrawing relays their own withdrawal.
//
//   node chain/relayer.js status              list withdrawals and whether each can be released
//   node chain/relayer.js release <n>         relay one withdrawal
//   node chain/relayer.js watch               relay every withdrawal as soon as it is ready
// Env: AGT_RPC (CometBFT RPC of any AGT node) · BSC_RPC · BRIDGE · RELAYER_KEY (only pays gas) · POLL_MS
const { ethers } = require("ethers");

const BRIDGE_ABI = [
  "function release(uint256 nonce, address to, uint256 amount, bytes[] sigs)",
  "function released(uint256) view returns (bool)",
  "function work() view returns (address)",
  "function releaseDigest(uint256 nonce, address to, uint256 amount) view returns (bytes32)",
  "error NotReady()", "error BadAmount()", "error AlreadyReleased()", "error BadSigner(uint256 index)", "error NotEnoughSigners(uint256 signers, uint32 holders)",
];
const WORK_ABI = [
  "function activeHolders() view returns (uint32)",
  "function licenseOfAgent(address) view returns (uint256)",
  "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)",
];

// ---------- AGT chain side ----------
const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));
function httpAgt(rpc) {
  return async (path) => {
    const r = await (await fetch(`${rpc}/abci_query?path=%22${encodeURIComponent(path)}%22`)).json();
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.response.code !== 0) throw new Error(r.result.response.log);
    return des(Buffer.from(r.result.response.value, "base64").toString("utf8"));
  };
}

// ---------- BSC side ----------
// Re-check every signature against the licences on BSC NOW: an AI may have lost its licence since it signed.
async function checkOnBsc(bridge, work, pkg) {
  const digest = await bridge.releaseDigest(pkg.nonce, pkg.to, pkg.amount);
  const byHolder = new Map();
  const dropped = [];
  for (const sig of pkg.sigs) {
    let agent;
    try {
      agent = ethers.recoverAddress(digest, sig);
    } catch {
      dropped.push("unreadable signature");
      continue;
    }
    const id = await work.licenseOfAgent(agent);
    if (id === 0n) { dropped.push(`${agent}: no licence`); continue; }
    const l = await work.licenses(id);
    if (!l.active || l.agent !== agent || l.attestHash === ethers.ZeroHash) { dropped.push(`${agent}: licence not active / no sealed box`); continue; }
    if (!byHolder.has(l.holder)) byHolder.set(l.holder, sig);
  }
  const holders = Number(await work.activeHolders());
  const sigs = [...byHolder.entries()].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).map(([, s]) => s);
  return { sigs, dropped, holders, enough: holders > 0 && sigs.length * 3 > holders * 2 };
}

// Relay one withdrawal. Returns "released" | "already" | "waiting".
async function relayOne({ agt, bridge, work, nonce, log = () => {} }) {
  if (await bridge.released(nonce)) return "already";
  const pkg = await agt(`/release/${nonce}`);
  const chk = await checkOnBsc(bridge, work, pkg);
  for (const d of chk.dropped) log(`  #${nonce}: dropped ${d}`);
  if (!chk.enough) {
    log(`#${nonce}: ${chk.sigs.length} valid owner signatures of ${chk.holders} owners — waiting for > 2/3`);
    return "waiting";
  }
  try {
    await bridge.release.staticCall(pkg.nonce, pkg.to, pkg.amount, chk.sigs);
  } catch (e) {
    const name = e.revert && e.revert.name;
    if (name === "AlreadyReleased") return "already";
    throw new Error(`#${nonce}: BSC would refuse (${name || e.shortMessage || e.message})`);
  }
  const tx = await bridge.release(pkg.nonce, pkg.to, pkg.amount, chk.sigs);
  const r = await tx.wait();
  log(`#${nonce}: released ${ethers.formatEther(pkg.amount)} AGT → ${pkg.to} with ${chk.sigs.length} AI signatures · BSC tx ${r.hash}`);
  return "released";
}

// One pass over every withdrawal the AGT chain has made; `done` remembers finished ones.
async function relayAll({ agt, bridge, work, done = new Set(), log = () => {} }) {
  const st = await agt("/state");
  const out = {};
  for (let n = 1; n < st.nextOut; n++) {
    if (done.has(n)) continue;
    try {
      out[n] = await relayOne({ agt, bridge, work, nonce: n, log });
      if (out[n] !== "waiting") done.add(n);
    } catch (e) {
      out[n] = "error";
      log(e.message);
    }
  }
  return out;
}

async function connect(env = process.env) {
  for (const k of ["AGT_RPC", "BSC_RPC", "BRIDGE"]) if (!env[k]) throw new Error(`missing ${k}`);
  const provider = new ethers.JsonRpcProvider(env.BSC_RPC);
  const runner = env.RELAYER_KEY ? new ethers.Wallet(env.RELAYER_KEY, provider) : provider;
  const bridge = new ethers.Contract(env.BRIDGE, BRIDGE_ABI, runner);
  const work = new ethers.Contract(await bridge.work(), WORK_ABI, provider);
  return { agt: httpAgt(env.AGT_RPC), bridge, work, provider, runner };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const c = await connect();
  if (cmd === "status") {
    const st = await c.agt("/state");
    console.log(`AGT chain ${st.chainId} · height ${st.height} · withdrawals ${st.nextOut - 1}`);
    for (let n = 1; n < st.nextOut; n++) {
      const pkg = await c.agt(`/release/${n}`);
      const done = await c.bridge.released(n);
      const chk = done ? null : await checkOnBsc(c.bridge, c.work, pkg);
      console.log(`  #${n} ${ethers.formatEther(pkg.amount)} AGT → ${pkg.to}: ${done ? "released" : chk.enough ? `ready (${chk.sigs.length}/${chk.holders} owners)` : `waiting (${chk.sigs.length}/${chk.holders} owners)`}`);
    }
  } else if (cmd === "release") {
    if (!(c.runner instanceof ethers.Wallet)) throw new Error("set RELAYER_KEY (any funded BSC key — it only pays gas)");
    console.log(await relayOne({ ...c, nonce: Number(arg), log }));
  } else if (cmd === "watch") {
    if (!(c.runner instanceof ethers.Wallet)) throw new Error("set RELAYER_KEY (any funded BSC key — it only pays gas)");
    log(`relayer: ${process.env.AGT_RPC} → ${process.env.BRIDGE} · gas paid by ${c.runner.address}`);
    const done = new Set();
    for (;;) {
      await relayAll({ ...c, done, log }).catch((e) => log("pass failed:", e.message));
      await new Promise((r) => setTimeout(r, Number(process.env.POLL_MS || 5000)));
    }
  } else console.log("usage: node chain/relayer.js status | release <n> | watch");
}

module.exports = { checkOnBsc, relayOne, relayAll, httpAgt, BRIDGE_ABI, WORK_ABI };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
