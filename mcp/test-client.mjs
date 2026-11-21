// Talks to server.mjs over stdio with raw JSON-RPC: initialize, list tools, call each read-only tool.
import { spawn } from "node:child_process";
const p = spawn(process.execPath, ["server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const waiters = new Map(); let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
const call = (method, params) => new Promise((res) => { const n = ++id; waiters.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } });
console.log("server:", init.result ? init.result.serverInfo.name + " · protocol " + init.result.protocolVersion : JSON.stringify(init.error));
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await call("tools/list", {});
console.log("tools:", list.result.tools.map((t) => t.name).join(", "));
for (const [name, args] of [["agt_overview", {}], ["agt_trades", {}], ["agt_licences", { max: 5 }], ["agt_open_work", {}], ["agt_how_to_join", {}], ["agt_reproduce", {}], ["agt_verify_box", { evidence: process.argv[2] || "{}" }]]) {
  const r = await call("tools/call", { name, arguments: args });
  const t = r.result ? r.result.content[0].text : JSON.stringify(r.error);
  console.log(`— ${name}: ${r.result && r.result.isError ? "ERROR " : ""}${t.replace(/\s+/g, " ").slice(0, 180)}`);
}
p.kill();
