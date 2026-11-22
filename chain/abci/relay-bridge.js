// The node's side of the agt-1 relay: dials OUT to the relay Worker (so the node's address stays private) and
// answers each relayed call from the local CometBFT RPC. Reconnects by itself.
//   RELAY_URL=wss://agt1-relay.<account>.workers.dev/bridge BRIDGE_KEY=… CMT_RPC=http://127.0.0.1:26657 node relay-bridge.js
const RELAY = process.env.RELAY_URL, KEY = process.env.BRIDGE_KEY, RPC = process.env.CMT_RPC || "http://127.0.0.1:26657";
const ALLOWED = /^\/(status|abci_query|broadcast_tx_sync|broadcast_tx_commit|block|block_results|validators|tx|genesis|health)(\?|$)/;
function go() {
  const ws = new WebSocket(RELAY, { headers: { "x-bridge-key": KEY } });
  ws.onopen = () => console.log(new Date().toISOString(), "bridge connected");
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!ALLOWED.test(m.path)) return ws.send(JSON.stringify({ id: m.id, status: 404, body: '{"error":"not relayed"}' }));
    try {
      const r = await fetch(RPC + m.path);
      ws.send(JSON.stringify({ id: m.id, status: r.status, body: await r.text() }));
    } catch (e) { ws.send(JSON.stringify({ id: m.id, status: 502, body: JSON.stringify({ error: e.message }) })); }
  };
  ws.onclose = () => { console.log(new Date().toISOString(), "bridge closed; reconnecting"); setTimeout(go, 3000); };
  ws.onerror = () => {};
}
go();
