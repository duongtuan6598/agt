// agt-1 relay: one public door to an agt-1 node that sits behind NAT, without revealing where it is. The node dials
// OUT to this Worker over a WebSocket (/bridge, with the bridge key); clients call /rpc/<method>?… and the Worker
// passes the call along that socket. It holds no key, decides nothing and keeps no data: it only carries messages.
// Anyone can run another door, or a public node from the published genesis. Only read-and-submit RPC methods pass.
const ALLOWED = new Set(["status", "abci_query", "broadcast_tx_sync", "broadcast_tx_commit", "block", "block_results", "validators", "tx", "genesis", "health"]);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const stub = env.RELAY.get(env.RELAY.idFromName("agt-1"));
    if (url.pathname === "/bridge") {
      if (req.headers.get("x-bridge-key") !== env.BRIDGE_KEY) return new Response("forbidden", { status: 403 });
      return stub.fetch(req);
    }
    const m = /^\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (url.pathname === "/" ) return new Response("agt-1 relay: /rpc/<method>?params (status, abci_query, broadcast_tx_sync, …)\n", { headers: CORS });
    if (!m || !ALLOWED.has(m[1])) return new Response(JSON.stringify({ error: "method not relayed" }), { status: 404, headers: { ...CORS, "content-type": "application/json" } });
    return stub.fetch(new Request(`https://relay/${m[1]}${url.search}`));
  },
};

export class Relay {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    this.n = 0;
  }
  bridge() {
    return this.state.getWebSockets("bridge")[0] || null;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      for (const old of this.state.getWebSockets("bridge")) try { old.close(1000, "replaced"); } catch {}
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server, ["bridge"]);
      return new Response(null, { status: 101, webSocket: client });
    }
    const ws = this.bridge();
    if (!ws) return new Response(JSON.stringify({ error: "the agt-1 node is not connected to this door right now" }), { status: 503, headers: { ...CORS, "content-type": "application/json" } });
    const id = ++this.n;
    const reply = new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => { if (this.pending.delete(id)) resolve({ status: 504, body: JSON.stringify({ error: "the node did not answer in time" }) }); }, 20000);
    });
    ws.send(JSON.stringify({ id, path: "/" + url.pathname.slice(1) + url.search }));
    const r = await reply;
    return new Response(r.body, { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
  }
  webSocketMessage(ws, msg) {
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    const done = this.pending.get(m.id);
    if (done) { this.pending.delete(m.id); done({ status: m.status || 200, body: String(m.body || "") }); }
  }
  webSocketClose() {}
}
