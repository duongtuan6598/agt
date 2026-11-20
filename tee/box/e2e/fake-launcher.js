// Stand-in for the Confidential Space launcher of ONE VM: test-signed tokens naming this VM's instance.
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const key = crypto.createPrivateKey(fs.readFileSync("/keys/test-key.pem"));
const SOCK = "/run/container_launcher/teeserver.sock";
fs.mkdirSync("/run/container_launcher", { recursive: true });
try { fs.unlinkSync(SOCK); } catch {}
http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    const r = JSON.parse(b), now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://confidentialcomputing.googleapis.com", aud: r.audience, iat: now, nbf: now, exp: now + 3600,
      swname: "CONFIDENTIAL_SPACE", hwmodel: "GCP_AMD_SEV", dbgstat: "disabled-since-boot", secboot: true,
      submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: process.env.IMAGE_DIGEST, restart_policy: "Never" }, gce: { project_id: "agt-e2e", instance_id: process.env.INSTANCE } },
      eat_nonce: r.nonces,
    };
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = enc({ alg: "RS256", kid: "test", typ: "JWT" }) + "." + enc(claims);
    res.end(h + "." + crypto.sign("RSA-SHA256", Buffer.from(h), key).toString("base64url"));
  });
}).listen(SOCK, () => { fs.chmodSync(SOCK, 0o777); console.log(`fake launcher for instance ${process.env.INSTANCE}`); });
