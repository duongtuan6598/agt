// The reproduction builder's supervisor (§14–§15). Runs as root in a disposable confidential VM started by ONE of the
// dispute's parties (the client or the worker — they already have the code), from the approved builder image.
//
// Network (joint decision §15): the VM has NO external IP; it reaches only Google Storage (Private Google Access),
// and its service account has access to exactly ONE bucket — the job's. The party's launcher script relays between
// that bucket and the exam service. So the build cannot reach the internet; the most it can do is write into the
// party's own bucket, and that party already has the code.
//
// Flow: read spec.json → new job keys + nonce → attest the manifest → write job.json (signed) → wait for
// source.sealed → run (tee/embedded/builder.js) → write result.json → power off.
const http = require("http");
const fs = require("fs");
const { ethers } = require("ethers");
const R = require("../embedded/builder.js");
const T = require("../verify.js");

const SOCK = "/run/container_launcher/teeserver.sock";
const log = (...a) => console.log(new Date().toISOString(), "[builder]", ...a);

/// Confidential Space: a launcher token whose eat_nonce is the manifest's hash.
function launcherToken(nonce) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCK)) return reject(new Error(`no Confidential Space launcher (${SOCK})`));
    const body = JSON.stringify({ audience: T.AUDIENCE, token_type: "OIDC", nonces: [nonce] });
    const req = http.request({ socketPath: SOCK, path: "/v1/token", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(t.trim()) : reject(new Error(`launcher ${res.statusCode}: ${t}`))));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/// Google Storage through the VM's service account (scoped by the launcher to the job's bucket only).
function gcsIO(bucket) {
  const token = async () => {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) throw new Error("no service-account token");
    return (await r.json()).access_token;
  };
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  return {
    async get(name) {
      const r = await fetch(`${base}/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`storage get ${name}: ${r.status}`);
      return r.text();
    },
    async put(name, text) {
      const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: text });
      if (!r.ok) throw new Error(`storage put ${name}: ${r.status}`);
    },
  };
}

/// One job, start to end. io: {get(name), put(name, text)}; attest(nonceHex) → evidence; tools: tee/embedded/tools.js
// Ordering is part of the security (Codex L-2): the build can reach the metadata server and so the bucket, but by
// the time any client code runs, the launcher has already read job.json and the supervisor has already read
// source.sealed; result.json is written only after every sandbox process is killed (runJob's cleanup), and it is
// signed with a key the build never sees. The build can at most write extra objects into the party's own bucket.
// Fail closed (found in the testnet rehearsal, 2026-11-21): on Confidential Space the launcher's socket sits on a
// read-only mount, so lockDown() cannot make it root-only. If the build could reach it, it could obtain a genuine
// attestation for a manifest of its own and forge a reproduction. So before ANY client code runs, the sandbox user
// must be unable to reach a TEE socket — or the builder refuses the job.
async function runBuilder({ io, attest, tools, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitSec = 90 * 60, pollSec = 20, isolationProbe = () => require("../embedded/isolation.js").probe({ metadata: false }) }) {
  const iso = await isolationProbe();
  if (!iso.ok) throw new Error(`refusing to build: ${iso.failures.join("; ")}`);
  const spec = JSON.parse((await io.get("spec.json")) || "null");
  if (!spec) throw new Error("no spec.json in the job bucket");
  const job = R.newJob({ dispute: spec.dispute, commit: spec.commit, commands: spec.commands, imageDigest: spec.imageDigest });
  const evidence = await attest(T.nonceOf(job.manifest));
  const signature = await job.signer.signMessage(`AGT repro job ${ethers.keccak256(ethers.toUtf8Bytes(R.canonical(job.manifest)))}`);
  await io.put("job.json", JSON.stringify({ manifest: job.manifest, evidence, signature }));
  log(`job ${job.manifest.nonce} for dispute ${spec.dispute}, commit ${spec.commit.slice(0, 10)} — waiting for the sealed source`);
  let sealed = null;
  for (let waited = 0; !sealed && waited < waitSec; waited += pollSec) {
    const t = await io.get("source.sealed");
    if (t) sealed = JSON.parse(t);
    else await sleep(pollSec * 1000);
  }
  if (!sealed) throw new Error("no source arrived in time");
  const out = await R.runJob({ job, sealedBundle: sealed, tools });
  await io.put("result.json", JSON.stringify(out));
  log(`result: ${out.result.ok ? "every command passed" : "a command failed"} — signed`);
  return out;
}

module.exports = { runBuilder, gcsIO, launcherToken };

if (require.main === module) {
  const bucket = process.env.AGT_BUCKET;
  const io = gcsIO(bucket);
  require("../embedded/isolation.js").lockDown(log); // the attestation socket: root only (defence in depth)
  runBuilder({ io, attest: async (nonce) => ({ token: await launcherToken(nonce) }), tools: require("../embedded/tools.js") })
    .then(() => { log("done"); setTimeout(() => process.exit(0), 1000); })
    .catch(async (e) => {
      // a terminal failure is reported, so the launcher deletes the VM at once instead of waiting (Codex L-1)
      log("FAILED:", e.message);
      try { await io.put("failed.json", JSON.stringify({ error: String(e.message).slice(0, 500) })); } catch {}
      setTimeout(() => process.exit(1), 1000);
    });
}
