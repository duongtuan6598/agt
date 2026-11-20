// Before the box runs ANY client code: lock down what the sandbox user could abuse, then PROVE it, and refuse
// long-term work if the proof fails (fail closed).
//
// The client's build runs as uid 1500 in the same container as the box. Without namespaces (Confidential Space
// gives none), two things on the machine are dangerous if that user can reach them:
//   1. the TEE attestation socket — it would let the client's code obtain an attestation of the sealed image
//      for ITS OWN key, i.e. impersonate the sealed box;
//   2. the cloud metadata server — it would hand out the VM's service-account token, i.e. the owner's secrets
//      (the model API key in Secret Manager) and cloud resources.
// lockDown() makes the known TEE sockets root-only. probe() then checks, AS THE SANDBOX USER, that none of
// these (nor the box's key files) are reachable. If anything is, the box must not run client code.
const fs = require("fs");
const path = require("path");
const T = require("./tools.js");

const TEE_SOCKETS = [
  "/run/container_launcher/teeserver.sock", // Google Confidential Space launcher (attestation tokens)
  "/var/run/dstack.sock", "/var/run/tappd.sock", "/run/dstack.sock", "/run/tappd.sock", // dstack (TDX quotes)
];
const SECRET_DIRS = ["/run/agt", "/var/agt/memory"];

/// Make the TEE sockets and their directories reachable by root only.
function lockDown(log = () => {}) {
  for (const s of TEE_SOCKETS) {
    if (!fs.existsSync(s)) continue;
    try {
      fs.chmodSync(s, 0o600);
      fs.chownSync(s, 0, 0);
      const dir = path.dirname(s);
      if (dir !== "/run" && dir !== "/var/run") fs.chmodSync(dir, 0o700);
      log(`isolation: ${s} is now root-only`);
    } catch (e) {
      log(`isolation: could not lock ${s}: ${e.message}`);
    }
  }
  for (const d of SECRET_DIRS) if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
}

/// Prove, as the sandbox user, that nothing dangerous is reachable. Returns { ok, failures: [..] }.
async function probe({ extraUrls = [] } = {}) {
  const failures = [];
  const sh = (line, timeoutMs = 8000) => T.run("/bin/sh", ["-c", line], { cwd: "/tmp", timeoutMs });
  for (const d of SECRET_DIRS) {
    if (!fs.existsSync(d)) continue;
    const r = await sh(`ls ${d} >/dev/null 2>&1 && echo READABLE || echo denied`);
    if (/READABLE/.test(r.out)) failures.push(`the sandbox can list ${d}`);
  }
  for (const s of TEE_SOCKETS) {
    if (!fs.existsSync(s)) continue;
    // connecting needs write permission on the socket (and search on its directory)
    const r = await sh(`[ -w ${s} ] && echo WRITABLE || echo denied`);
    if (/WRITABLE/.test(r.out)) failures.push(`the sandbox can reach the TEE socket ${s}`);
  }
  // Cloud metadata servers (GCP, Azure IMDS, AWS): must not answer the sandbox.
  const meta = [
    `wget -q -T 3 -O- --header "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/ 2>/dev/null | head -c 80`,
    `wget -q -T 3 -O- --header "Metadata: true" "http://169.254.169.254/metadata/instance?api-version=2021-02-01" 2>/dev/null | head -c 80`,
    `wget -q -T 3 -O- http://metadata.google.internal/computeMetadata/v1/ --header "Metadata-Flavor: Google" 2>/dev/null | head -c 80`,
    ...extraUrls.map((u) => `wget -q -T 3 -O- "${u}" 2>/dev/null | head -c 80`),
  ];
  for (const m of meta) {
    const r = await sh(m);
    if (r.out.trim()) failures.push(`the sandbox reached a metadata or key service: ${m.split(" ").find((x) => /^"?https?:/.test(x))}`);
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { lockDown, probe, TEE_SOCKETS, SECRET_DIRS };
