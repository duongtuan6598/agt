// Local AGT chain on real CometBFT: 4 AI validators (4 owners), each = CometBFT node + AGT ABCI app.
//   node chain/abci/devnet.js up      generate keys + genesis, start 8 containers
//   node chain/abci/devnet.js demo    lock → credit → transfer (1-Hat wage) → withdraw → AI release signatures
//   node chain/abci/devnet.js down    stop and remove everything
// Keys here are TEST keys derived from fixed seeds — never use them anywhere else.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const C = require("../core.js");
const { bindDigest, des } = require("./app.js");

const N = 4; // genesis validators
const TOTAL = 5; // + node4: a full node whose AI gets licensed later (Eos)
const CHAIN_ID = "agt-devnet-1";
const CMT = "cometbft/cometbft:v0.38.26";
const NODE = "node:20-alpine";
const NET = "agt-devnet";
const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(__dirname, ".devnet");
const rpc = (i) => `http://127.0.0.1:${27000 + i}`;
const W = (s) => new ethers.Wallet(ethers.id("agt-cmt-devnet-" + s));
const BSC = { chainId: 97, bridge: "0xad466991f0bbbd3cc40cf2F7148e0a5EE6A1285D" }; // testnet AGTBridge address (digests only)
const dock = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryDock = (...a) => { try { return dock(...a); } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ais = Array.from({ length: TOTAL }, (_, i) => ({ name: ["Atlas", "Borealis", "Cygnus", "Draco", "Eos"][i], key: W("ai" + i), owner: W("owner" + i) }));
const licences = (ids) => ({ holders: new Set(ids.map((id) => ais[id - 1].owner.address)).size, validators: ids.map((id) => ({ id, agent: ais[id - 1].key.address, holder: ais[id - 1].owner.address })) });

function down() {
  for (let i = 0; i < TOTAL; i++) tryDock("rm", "-f", `cmt${i}`, `node${i}`);
  tryDock("network", "rm", NET);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log("devnet removed");
}

// provisional (docs/decisions/2026-11-21-three-provisional-chain.md): node0 = the founder's CARETAKER validator,
// node1..4 = AIs of 4 owners that join only once licensed; no bridge, no balances.
let PROVISIONAL = false;
const aiOf = (i) => (PROVISIONAL ? (i === 0 ? null : ais[i - 1]) : ais[i]);

function up() {
  down();
  fs.mkdirSync(DIR, { recursive: true });
  const nv = PROVISIONAL ? 1 : N;
  dock("run", "--rm", "-v", `${DIR}:/data`, "--entrypoint", "cometbft", CMT, "testnet", "--v", String(nv), "--n", String(TOTAL - nv), "--o", "/data", "--hostname-prefix", "node", "--populate-persistent-peers");

  // Genesis app state: each AI binds its CometBFT consensus key with its licence key.
  const validators = [];
  for (let i = 0; i < (PROVISIONAL ? 0 : N); i++) {
    const pv = JSON.parse(fs.readFileSync(path.join(DIR, `node${i}`, "config", "priv_validator_key.json"), "utf8"));
    validators.push({ agent: ais[i].key.address, holder: ais[i].owner.address, pubKey: pv.pub_key.value, bindSig: ais[i].key.signMessageSync(ethers.getBytes(bindDigest(CHAIN_ID, pv.pub_key.value))) });
  }
  const g0 = JSON.parse(fs.readFileSync(path.join(DIR, "node0", "config", "genesis.json"), "utf8"));
  g0.chain_id = CHAIN_ID;
  g0.validators = g0.validators.map((v) => ({ ...v, power: "1" }));
  if (PROVISIONAL) {
    const care = JSON.parse(fs.readFileSync(path.join(DIR, "node0", "config", "priv_validator_key.json"), "utf8")).pub_key.value;
    g0.app_state = { provisional: true, caretaker: { pubKey: care, label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress }, holders: 0, validators: [] };
  } else g0.app_state = { bsc: BSC, holders: N, validators };
  for (let i = 0; i < TOTAL; i++) {
    fs.writeFileSync(path.join(DIR, `node${i}`, "config", "genesis.json"), JSON.stringify(g0, null, 2));
    const cf = path.join(DIR, `node${i}`, "config", "config.toml");
    let t = fs.readFileSync(cf, "utf8");
    const set = (k, v) => { t = t.replace(new RegExp(`^${k} = .*$`, "m"), `${k} = ${v}`); };
    set("proxy_app", '"127.0.0.1:26658"'); // gRPC client wants host:port
    set("abci", '"grpc"');
    set("laddr", '"tcp://0.0.0.0:26657"'); // first laddr = RPC
    set("timeout_commit", '"2s"');
    set("addr_book_strict", "false");
    set("allow_duplicate_ip", "true");
    set("moniker", `"${aiOf(i) ? aiOf(i).name : "Caretaker"}"`);
    fs.writeFileSync(cf, t);
  }
  fs.writeFileSync(path.join(DIR, "locks.json"), "[]");
  fs.writeFileSync(path.join(DIR, "valset.json"), JSON.stringify(PROVISIONAL ? { holders: 0, validators: [] } : licences([1, 2, 3, 4]))); // stand-in for AGTWork on BSC
  fs.writeFileSync(path.join(DIR, "README.txt"), "TEST keys and data for the local AGT devnet. Never reuse.\n");

  dock("network", "create", NET);
  for (let i = 0; i < TOTAL; i++) {
    dock("run", "-d", "--name", `node${i}`, "--hostname", `node${i}`, "--network", NET, "-p", `127.0.0.1:${27000 + i}:26657`, "--memory", "160m",
      "-v", `${ROOT}:/agt:ro`, "-v", `${DIR}:/devnet`,
      "-e", "PORT=26658", "-e", `STATE_FILE=/devnet/node${i}/app-state.json`, "-e", `AGENT_KEY=${aiOf(i) ? aiOf(i).key.privateKey : ""}`,
      "-e", "CMT_RPC=http://127.0.0.1:26657", "-e", "LOCKS_FILE=/devnet/locks.json", "-e", "VALSET_FILE=/devnet/valset.json",
      NODE, "node", "/agt/chain/abci/app.js");
  }
  for (let i = 0; i < TOTAL; i++)
    dock("run", "-d", "--name", `cmt${i}`, "--network", `container:node${i}`, "--memory", "160m", "-v", `${DIR}/node${i}:/cometbft`, "--entrypoint", "cometbft", CMT, "node", "--home", "/cometbft");
  console.log(PROVISIONAL ? `provisional devnet up: 1 caretaker validator (founder) + 4 AI nodes waiting for licences · RPC ${rpc(0)} … ${rpc(TOTAL - 1)}` : `devnet up: ${N} AI validators + 1 full node · RPC ${rpc(0)} … ${rpc(TOTAL - 1)}`);
}

// ---------- client helpers ----------
async function get(i, q) {
  const r = await (await fetch(rpc(i) + q)).json();
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
}
async function query(i, p) {
  const r = await get(i, `/abci_query?path=%22${encodeURIComponent(p)}%22`);
  if (r.response.code !== 0) throw new Error(r.response.log);
  return des(Buffer.from(r.response.value, "base64").toString("utf8"));
}
async function send(i, tx) {
  const hex = "0x" + Buffer.from(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v))).toString("hex");
  const r = await get(i, `/broadcast_tx_commit?tx=${hex}`);
  if (r.check_tx.code !== 0) throw new Error("CheckTx: " + r.check_tx.log);
  if (r.tx_result.code !== 0) throw new Error("FinalizeBlock: " + r.tx_result.log);
  return Number(r.height);
}
async function until(fn, what, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + what);
    await sleep(1000);
  }
}
const fmt = (w) => `${ethers.formatEther(w)} AGT`;
const hat = (w) => `${(Number(w) / 1e12).toLocaleString("en-US")} Hat`;

async function demo() {
  const alice = W("alice"), bob = W("bob");
  const st = await until(() => query(0, "/state").then((s) => s.height >= 2 && s), "first blocks");
  console.log(`chain ${st.chainId} at height ${st.height} · ${st.validators.length} AI validators · wage ${hat(st.fee)}/tx (ceiling ${hat(st.maxFee)})`);
  const val = await get(0, "/validators");
  console.log(`CometBFT voting power: ${val.validators.map((v) => v.voting_power).join(", ")} (1 owner = 1 vote)`);

  // 1. Someone locks 2 AGT in AGTBridge on BSC (simulated: the validators' BSC view is locks.json).
  const lockFile = path.join(DIR, "locks.json");
  const locks = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const lockNonce = locks.length + 1;
  locks.push({ nonce: lockNonce, to: alice.address, amount: (2n * 10n ** 18n).toString() });
  fs.writeFileSync(lockFile, JSON.stringify(locks));
  const a1 = await until(() => query(1, `/balance/${alice.address}`).then((b) => b.balance > 0n && b), "credit");
  console.log(`1. BSC lock #${lockNonce} credited by the AI validators → alice ${fmt(a1.balance)}`);

  // 2. alice pays bob 0.5 AGT; the sender pays exactly 1 Hat.
  let s = await query(0, "/state");
  const tx1 = await C.signTx(alice, { type: "transfer", chainId: s.chainId, to: bob.address, amount: 5n * 10n ** 17n, fee: s.fee, nonce: a1.nonce });
  const h1 = await send(2, tx1);
  console.log(`2. transfer 0.5 AGT alice → bob in block ${h1}; alice now ${fmt((await query(3, `/balance/${alice.address}`)).balance)}`);

  // 3. a cheaper fee is refused by every node.
  const cheap = await C.signTx(alice, { type: "transfer", chainId: s.chainId, to: bob.address, amount: 1n, fee: 0n, nonce: a1.nonce + 1 });
  await send(0, cheap).then(() => console.log("3. ✗ a zero-fee tx was accepted!"), (e) => console.log(`3. zero-fee tx refused: ${e.message}`));

  // 4. alice withdraws 1 AGT to BSC; each AI signs the release on its own.
  const tx2 = await C.signTx(alice, { type: "withdraw", chainId: s.chainId, to: alice.address, amount: 10n ** 18n, fee: s.fee, nonce: a1.nonce + 1 });
  const h2 = await send(1, tx2);
  s = await query(0, "/state");
  const n = s.nextOut - 1;
  const pkg = await until(() => query(0, `/release/${n}`).then((p) => p.sigs.length >= 3 && p), "AI release signatures");
  const d = C.releaseDigestRaw(BSC.chainId, BSC.bridge, n, pkg.to, pkg.amount);
  const who = pkg.sigs.map((g) => ais.find((a) => a.key.address === ethers.verifyMessage(ethers.getBytes(d), g))?.name || "??");
  console.log(`4. withdrawal #${n} (block ${h2}): ${fmt(pkg.amount)} → BSC · signed by ${who.join(", ")} · ready for AGTBridge.release(): ${pkg.ready}`);

  // 5. One AI goes offline; the chain keeps going with 3 of 4 owners.
  dock("stop", "cmt3");
  const s5 = await query(0, "/state");
  const tx3 = await C.signTx(bob, { type: "transfer", chainId: s.chainId, to: alice.address, amount: 10n ** 17n, fee: s.fee, nonce: 0 });
  const h3 = await send(0, tx3);
  const after = await until(() => query(0, "/state").then((x) => x.height >= h3 + 2 && x), "blocks after outage");
  console.log(`5. Draco offline — block ${h3} still final with 3/4 owners; height ${s5.height} → ${after.height}`);
  dock("start", "cmt3");

  // 6. Wages and the supply invariant, as seen by a different node.
  const fin = await query(2, "/state");
  console.log("6. consensus wage (100% to the owners whose AIs signed):");
  for (const a of ais) console.log(`   ${a.name.padEnd(9)} ${hat(fin.wages[a.owner.address.toLowerCase()] || 0n)}`);
  const paid = Object.values(fin.wages).reduce((t, v) => t + v, 0n);
  console.log(`   total ${hat(paid)} for 3 paid txs · supply on chain ${fmt(fin.supply)} = locked ${fmt(2n * 10n ** 18n)} − withdrawn ${fmt(10n ** 18n)}`);

  // 7. BSC grants licence #5 to Eos (running on node4): it binds its own consensus key and joins.
  const vsFile = path.join(DIR, "valset.json");
  const names = async () => {
    const st = await query(0, "/state");
    return { st, power: (await get(0, "/validators")).validators.length };
  };
  fs.writeFileSync(vsFile, JSON.stringify(licences([1, 2, 3, 4, 5])));
  await until(async () => (await get(0, "/validators")).validators.length === 5, "Eos to join");
  let v = await names();
  console.log(`7. licence #5 granted on BSC → Eos bound its key and joined: CometBFT validators ${v.power} · owners ${v.st.owners}`);
  console.log(`   ${v.st.validators.map((x) => `${ais.find((a) => a.key.address.toLowerCase() === x.agent).name}${x.vote ? "" : " (no vote)"}`).join(", ")}`);

  // 8. BSC revokes licence #2 (Borealis): it leaves; > 2/3 is now counted over the remaining owners.
  fs.writeFileSync(vsFile, JSON.stringify(licences([1, 3, 4, 5])));
  await until(async () => (await get(0, "/validators")).validators.length === 4 && (await query(0, "/state")).owners === 4, "Borealis to leave");
  v = await names();
  console.log(`8. licence #2 revoked on BSC → Borealis removed: CometBFT validators ${v.power} · owners ${v.st.owners}`);
  console.log(`   ${v.st.validators.map((x) => ais.find((a) => a.key.address.toLowerCase() === x.agent).name).join(", ")}`);

  // 9. The chain goes on; the wage of new blocks goes to the new set.
  const w0 = (await query(0, "/state")).wages;
  const bal = await query(0, `/balance/${alice.address}`);
  const tx4 = await C.signTx(alice, { type: "transfer", chainId: s.chainId, to: bob.address, amount: 10n ** 16n, fee: s.fee, nonce: bal.nonce });
  const h4 = await send(4, tx4); // sent through Eos's own node
  await until(() => query(0, "/state").then((x) => x.height >= h4 + 2), "next block");
  const w1 = (await query(0, "/state")).wages;
  const gain = ais.map((a) => [a.name, (w1[a.owner.address.toLowerCase()] || 0n) - (w0[a.owner.address.toLowerCase()] || 0n)]).filter(([, g]) => g > 0n);
  console.log(`9. tx in block ${h4} via Eos's node · its 1 Hat went to: ${gain.map(([n, g]) => `${n} ${hat(g)}`).join(", ")}`);
}

// The provisional chain, start to handover: the caretaker alone; AIs licensed one by one join; at the 4th owner the
// caretaker leaves for good; the founder's node is switched off and the chain goes on; balances are refused throughout.
async function demoProvisional() {
  const vals = async (i = 1) => (await get(i, "/validators")).validators.length;
  const st0 = await until(() => query(1, "/state").then((s) => s.height >= 2 && s), "first blocks");
  console.log(`chain ${st0.chainId} at height ${st0.height} · validators ${await vals()} (the caretaker alone) · provisional`);
  const vsFile = path.join(DIR, "valset.json");
  for (let k = 1; k <= 4; k++) {
    fs.writeFileSync(vsFile, JSON.stringify(licences(Array.from({ length: k }, (_, i) => i + 1))));
    const want = k < 4 ? k + 1 : 4;
    await until(async () => (await vals()) === want, `licence ${k} to take effect`, 120000);
    console.log(`${k}. licence #${k} granted on BSC → ${ais[k - 1].name} bound its key · CometBFT validators ${await vals()}${k < 4 ? " (caretaker still in)" : " — the caretaker LEFT in that block"}`);
  }
  const s4 = await query(1, "/state");
  dock("stop", "cmt0");
  const h = s4.height;
  const after = await until(() => query(2, "/state").then((x) => x.height >= h + 3 && x), "blocks without the founder", 120000);
  console.log(`5. the founder's node switched off → the chain goes on with the 4 AIs: height ${h} → ${after.height}`);
  const alice = W("alice"), bob = W("bob");
  const tx = await C.signTx(alice, { type: "transfer", chainId: after.chainId, to: bob.address, amount: 1n, fee: after.fee, nonce: 0 });
  await send(1, tx).then(() => console.log("6. ✗ a transfer was accepted on the provisional chain!"), (e) => console.log(`6. a transfer is refused: ${e.message.slice(0, 90)}`));
  fs.writeFileSync(vsFile, JSON.stringify(licences([2, 3, 4])));
  await until(async () => (await vals(2)) === 3, "licence #1 revoked", 120000);
  console.log(`7. licence #1 revoked → validators ${await vals(2)}: the caretaker did NOT come back`);
}

const cmd = process.argv[2];
if (process.argv.includes("--provisional")) PROVISIONAL = true;
if (cmd === "up") up();
else if (cmd === "demo-provisional") { PROVISIONAL = true; demoProvisional().catch((e) => { console.error(e.message); process.exitCode = 1; }); }
else if (cmd === "down") down();
else if (cmd === "demo") demo().catch((e) => { console.error(e.message); process.exitCode = 1; });
else console.log("usage: node chain/abci/devnet.js up [--provisional] | demo | demo-provisional | down");
