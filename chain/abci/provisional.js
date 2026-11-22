// The provisional AGT chain, run by the founder as CARETAKER (docs/decisions/2026-11-21-three-provisional-chain.md).
// One CometBFT validator (the caretaker) + this ABCI app, following AGTWork licences on BSC testnet. No balances.
// Data and the caretaker's consensus key live OUTSIDE the repo (AGT_CHAIN_DIR, default C:/DuongTuan/agt-chain).
// usage: node chain/abci/provisional.js up | status | down      (containers restart by themselves after a reboot)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const CHAIN_ID = "agt-1"; // AGT's own ledger (docs/decisions/2026-11-22-own-ledger-now.md); agt-provisional-1 is archived
const CMT = "cometbft/cometbft:v0.38.26", NODE = "node:20-alpine", NET = "agt-chain";
const DIR = process.env.AGT_CHAIN_DIR || "C:/DuongTuan/agt-chain-1";
const SNAPSHOT = require("../genesis/agt-1-snapshot.json"); // opening balances: AGT on BSC at one block, rebuilt by snapshot.js
const APP = path.join(DIR, "app"), HOME = path.join(DIR, "cometbft");
const WORK = require("../../deployments/bscTestnet.json").contracts.AGTWork;
const RELAY_URL = process.env.RELAY_URL || "wss://agt1-relay.agtcoin.workers.dev/bridge";
const BSC_RPC = process.env.BSC_RPC || "https://bsc-testnet-rpc.publicnode.com";
const dock = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryDock = (...a) => { try { return dock(...a); } catch { return ""; } };

function up() {
  // the app runs from a frozen copy of chain/ (a git checkout must not change a running node)
  fs.rmSync(APP, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, ".."), APP, { recursive: true, filter: (p) => !p.includes(".devnet") });
  // ethers comes from the repo root: pin the same version inside the copy
  fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify({ private: true, dependencies: { ethers: ethers.version } }));
  execFileSync("npm install --omit=dev --no-audit --no-fund", { cwd: APP, stdio: "ignore", shell: true });
  if (!fs.existsSync(path.join(HOME, "config", "genesis.json"))) {
    fs.mkdirSync(HOME, { recursive: true });
    dock("run", "--rm", "-v", `${HOME}:/cometbft`, "--entrypoint", "cometbft", CMT, "init", "--home", "/cometbft");
    const pv = JSON.parse(fs.readFileSync(path.join(HOME, "config", "priv_validator_key.json"), "utf8"));
    const g = JSON.parse(fs.readFileSync(path.join(HOME, "config", "genesis.json"), "utf8"));
    g.chain_id = CHAIN_ID;
    g.validators = [{ ...g.validators[0], power: "1", name: "caretaker" }];
    g.app_state = { provisional: true, caretaker: { pubKey: pv.pub_key.value, label: "founder" }, bsc: { chainId: 97, bridge: ethers.ZeroAddress, work: WORK }, holders: 0, validators: [], ledger: SNAPSHOT };
    fs.writeFileSync(path.join(HOME, "config", "genesis.json"), JSON.stringify(g, null, 2));
    const cf = path.join(HOME, "config", "config.toml");
    let t = fs.readFileSync(cf, "utf8");
    const set = (k, v) => { t = t.replace(new RegExp(`^${k} = .*$`, "m"), `${k} = ${v}`); };
    set("proxy_app", '"127.0.0.1:26658"'); set("abci", '"grpc"'); set("laddr", '"tcp://0.0.0.0:26657"');
    set("timeout_commit", '"5s"'); set("moniker", '"caretaker"');
    fs.writeFileSync(cf, t);
    fs.writeFileSync(path.join(DIR, "README.txt"), "AGT provisional chain, caretaker node. priv_validator_key.json is the caretaker's consensus key: never publish, never copy into the repo.\n");
    console.log("genesis written:", path.join(HOME, "config", "genesis.json"));
  }
  down(true);
  dock("network", "create", NET);
  dock("run", "-d", "--name", "agt-app", "--restart", "unless-stopped", "--network", NET, "-p", "127.0.0.1:26657:26657", "-p", "26656:26656", "--memory", "200m",
    "-v", `${APP}:/chain:ro`, "-v", `${DIR}:/data`,
    "-e", "PORT=26658", "-e", "STATE_FILE=/data/app-state.json", "-e", `BSC_RPC=${BSC_RPC}`, "-e", "CMT_RPC=http://127.0.0.1:26657",
    NODE, "node", "/chain/abci/app.js");
  dock("run", "-d", "--name", "agt-cmt", "--restart", "unless-stopped", "--network", "container:agt-app", "--memory", "200m",
    "-v", `${HOME}:/cometbft`, "--entrypoint", "cometbft", CMT, "node", "--home", "/cometbft");
  // the relay bridge: dials OUT to the public door (agt1-relay Worker), so the laptop's address stays private
  const envFile = path.join(__dirname, "..", "..", ".env");
  const key = fs.existsSync(envFile) ? (fs.readFileSync(envFile, "utf8").match(/^AGT1_BRIDGE_KEY=(.*)$/m) || [])[1] : "";
  if (key) {
    dock("run", "-d", "--name", "agt-bridge", "--restart", "unless-stopped", "--network", "container:agt-app", "--memory", "64m",
      "-v", `${APP}:/chain:ro`, "-e", `RELAY_URL=${RELAY_URL}`, "-e", `BRIDGE_KEY=${key.trim()}`, "-e", "CMT_RPC=http://127.0.0.1:26657",
      "node:22-alpine", "node", "/chain/abci/relay-bridge.js");
    console.log(`public door: ${RELAY_URL.replace("wss://", "https://").replace("/bridge", "/rpc/status")}`);
  }
  console.log(`caretaker node up · chain ${CHAIN_ID} · licences, prices and balances on agt-1 itself; BSC is read only for deposits into its Kho · RPC http://127.0.0.1:26657 · P2P :26656`);
}

function down(quiet) {
  tryDock("rm", "-f", "agt-bridge", "agt-cmt", "agt-app");
  tryDock("network", "rm", NET);
  if (!quiet) console.log("caretaker node stopped (data kept in " + DIR + ")");
}

async function status() {
  const r = await (await fetch("http://127.0.0.1:26657/status")).json();
  const v = await (await fetch("http://127.0.0.1:26657/validators")).json();
  console.log(`${r.result.node_info.network} · height ${r.result.sync_info.latest_block_height} · ${r.result.sync_info.latest_block_time} · validators ${v.result.total}`);
}

const cmd = process.argv[2];
if (cmd === "up") up();
else if (cmd === "down") down();
else if (cmd === "status") status().catch((e) => { console.error("not reachable:", e.message); process.exitCode = 1; });
else console.log("usage: node chain/abci/provisional.js up | status | down");
