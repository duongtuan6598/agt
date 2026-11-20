// Run INSIDE the embedded image as root. A fake TEE socket and a fake metadata server are put where the real
// ones would be; lockDown() must make the socket unreachable, and probe() must catch what stays reachable.
//   docker run --rm -v <agt>/tee/embedded/test:/agt/tee/embedded/test:ro --entrypoint node agt-box-embedded /agt/tee/embedded/test/isolation-probe.js
const fs = require("fs");
const net = require("net");
const http = require("http");
const I = require("../isolation.js");
let bad = 0;
const check = (n, ok, why = "") => { console.log(`${ok ? "✔" : "✘"} ${n}${why ? " — " + why : ""}`); if (!ok) bad++; };
(async () => {
  fs.mkdirSync("/run/container_launcher", { recursive: true, mode: 0o755 });
  const sock = "/run/container_launcher/teeserver.sock";
  try { fs.unlinkSync(sock); } catch {}
  const srv = net.createServer((c) => c.end("attestation token")).listen(sock);
  await new Promise((r) => srv.on("listening", r));
  fs.chmodSync(sock, 0o777); // as an unprotected launcher might leave it
  const before = await I.probe();
  check("the probe sees an open TEE socket", !before.ok && before.failures.some((f) => f.includes("TEE socket")), before.failures.join("; "));
  I.lockDown(console.log);
  const after = await I.probe();
  check("after lockDown the sandbox cannot reach the TEE socket", !after.failures.some((f) => f.includes("TEE socket")), after.failures.join("; ") || "clean");

  // A metadata-like service reachable from the sandbox must be caught (the probe's extra URL stands in for it).
  const meta = http.createServer((q, r) => r.end("service-account-token")).listen(18080, "127.0.0.1");
  await new Promise((r) => meta.on("listening", r));
  const m = await I.probe({ extraUrls: ["http://127.0.0.1:18080/token"] });
  check("a reachable key/metadata service makes the probe fail (long-term work stays disabled)", !m.ok && m.failures.some((f) => f.includes("127.0.0.1:18080")), m.failures.join("; "));
  meta.close(); srv.close();
  const clean = await I.probe();
  check("with nothing reachable the probe passes (here: no cloud metadata server in local Docker)", clean.ok, clean.failures.join("; ") || "clean");
  process.exit(bad ? 1 : 0);
})();
