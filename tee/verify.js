// Sealed-box evidence for AGT AIs (Charter Article 12) — Google Confidential Space (Intel TDX / AMD SEV).
//
// Inside the box the AI generates its own keys, then asks the hardware-backed launcher for an attestation
// token whose nonce is the hash of a MANIFEST:
//   { Charter hash, system-prompt hash, AI licence key, CometBFT key, chain }   (the image digest is in the token itself)
// The token is signed by Google's attestation service and says: this exact container image runs on genuine
// TDX/SEV hardware, in production mode (no debug, no SSH, operator cannot override the command), and
// it was the one that produced this manifest. So the owner cannot have the keys and cannot change the code.
//
// Evidence = { manifest, token } is published (IPFS / exam record). On chain only attestHash is stored:
//   attestHash = keccak(canon({ manifestHash, tokenHash }))
// Anyone can fetch the evidence, recompute attestHash and re-run verifyEvidence().
//
//   node tee/verify.js <evidence.json> [--policy tee/policy.json]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { hashOf } = require("../chain/core.js");

const ISSUER = "https://confidentialcomputing.googleapis.com";
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com";
const AUDIENCE = "agt-sealed-box";

const b64url = (s) => Buffer.from(s, "base64url");
const manifestHash = (m) => hashOf(m);
const nonceOf = (m) => manifestHash(m).slice(2); // 64 hex chars — within Confidential Space's 10–74 byte nonce limit
const attestHashOf = (ev) => hashOf({
  manifestHash: manifestHash(ev.manifest),
  tokenHash: ev.platform === "dstack-tdx" ? ethers.keccak256("0x" + String(ev.quote).replace(/^0x/, "")) : ethers.keccak256(ethers.toUtf8Bytes(ev.token)),
});
const fileHash = (p) => ethers.keccak256(fs.readFileSync(p));

async function fetchJwks() {
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error(`JWKS ${r.status}`);
  return (await r.json()).keys;
}

// RS256 JWT verification against a JWKS (no external library).
function verifyJwt(token, jwks) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const header = JSON.parse(b64url(parts[0]));
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`unknown signing key ${header.kid}`);
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key: jwk, format: "jwk" }), b64url(parts[2]));
  if (!ok) throw new Error("bad token signature");
  return JSON.parse(b64url(parts[1]));
}

// Checks that a token comes from a genuine, production AGT box (any manifest). Returns the claims.
function verifyBoxToken(token, { jwks, policy, now = Math.floor(Date.now() / 1000), checkExpiry = true }) {
  const c = verifyJwt(token, jwks);
  const fail = (m) => { throw new Error(m); };
  if (c.iss !== ISSUER) fail(`issuer ${c.iss}`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(policy.audience || AUDIENCE)) fail(`audience ${c.aud}`);
  if (checkExpiry && (c.exp < now || (c.nbf && c.nbf > now + 60))) fail("token expired or not yet valid");
  if (c.swname !== "CONFIDENTIAL_SPACE") fail(`not Confidential Space (${c.swname})`);
  if (!policy.hwmodels.includes(c.hwmodel)) fail(`hardware ${c.hwmodel} not allowed`);
  if (c.dbgstat !== "disabled-since-boot") fail(`debug image (${c.dbgstat}) — the operator could look inside`);
  if (c.secboot !== true) fail("secure boot off");
  const support = (c.submods && c.submods.confidential_space && c.submods.confidential_space.support_attributes) || [];
  if (!support.includes("STABLE")) fail("Confidential Space image is not a supported STABLE release");
  const ctr = (c.submods && c.submods.container) || {};
  if (!policy.imageDigests.includes(ctr.image_digest)) fail(`container ${ctr.image_digest} is not an approved AGT image`);
  if (ctr.restart_policy && ctr.restart_policy !== "Never") fail("restart policy must be Never (a restart would mean new keys)");
  return c;
}

const tokenNonces = (c) => (Array.isArray(c.eat_nonce) ? c.eat_nonce : [c.eat_nonce]);

// ---------- dstack on Intel TDX (no cloud provider in the trust path) ----------
// The quote is verified against Intel's root certificate; RTMR3 is replayed from the event log, which
// proves the compose-hash (the docker-compose that pins the AGT box image) and the instance id.
// Returns claims shaped like the Confidential Space ones, so licences and escrow treat both alike.
function verifyDstack(att, { policy, at, qeIdentity, tdx = require("./tdx.js") }) {
  const fail = (m) => { throw new Error(m); };
  const d = policy.dstack || {};
  const body = tdx.verifyQuote(att.quote, { at, qeIdentity });
  const ev = tdx.checkRtmr3(att.eventLog, body.rtmr3);
  const os = (d.osImages || []).some((o) => ["mrTd", "rtmr0", "rtmr1", "rtmr2"].every((k) => String(o[k]).toLowerCase() === body[k]));
  if (!os) fail(`dstack OS image (MRTD ${body.mrTd.slice(0, 16)}…) is not an approved release`);
  const compose = ev["compose-hash"];
  if (!compose || !(d.composeHashes || []).includes(compose)) fail(`compose ${compose} is not an approved AGT box`);
  if (!ev["instance-id"]) fail("no instance id in the event log");
  return {
    platform: "dstack-tdx", hwmodel: "INTEL_TDX", swname: "DSTACK",
    eat_nonce: [body.reportData.slice(0, 64)],
    submods: { container: { image_digest: `compose:${compose}` }, gce: { project_id: `dstack:${ev["app-id"] || ""}`, instance_id: ev["instance-id"] } },
  };
}

// Any attestation (a Confidential Space token, or a dstack quote + event log) → normalised claims.
function verifyAttestation(att, opts) {
  return att.platform === "dstack-tdx" ? verifyDstack(att, opts) : verifyBoxToken(att.token, opts);
}

// Returns { ok: true, claims, attestHash } or throws with the first rule that failed.
function verifyEvidence(ev, opts) {
  const c = verifyAttestation(ev, opts);
  const { policy } = opts;
  const fail = (m) => { throw new Error(m); };
  if (!tokenNonces(c).includes(nonceOf(ev.manifest))) fail("token was not issued for this manifest (nonce mismatch)");
  const m = ev.manifest;
  if (m.charterHash !== policy.charterHash) fail("manifest Charter ≠ current Charter");
  if (policy.promptHashes && !policy.promptHashes.includes(m.promptHash)) fail("system prompt not approved");
  if (!ethers.isAddress(m.agent)) fail("bad agent key");
  if (Buffer.from(String(m.cmtPubKey), "base64").length !== 32) fail("bad CometBFT key");
  return { ok: true, claims: c, attestHash: attestHashOf(ev) };
}

// The Charter the box must carry: both texts, so a change to either means a new attestation.
function charterHash(root = path.join(__dirname, "..")) {
  return hashOf({ vi: fileHash(path.join(root, "HIEN-CHUONG.md")), en: fileHash(path.join(root, "CHARTER.md")) });
}

function loadPolicy(file = path.join(__dirname, "policy.json")) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  return { audience: AUDIENCE, ...p, charterHash: p.charterHash === "current" ? charterHash() : p.charterHash };
}

module.exports = { ISSUER, AUDIENCE, JWKS_URL, verifyJwt, verifyBoxToken, verifyAttestation, verifyDstack, tokenNonces, verifyEvidence, manifestHash, nonceOf, attestHashOf, charterHash, loadPolicy, fetchJwks };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const file = args[0];
    const pi = args.indexOf("--policy");
    if (!file) return console.log("usage: node tee/verify.js <evidence.json> [--policy tee/policy.json]");
    const ev = JSON.parse(fs.readFileSync(file, "utf8"));
    const policy = loadPolicy(pi > 0 ? args[pi + 1] : undefined);
    const r = verifyEvidence(ev, { jwks: await fetchJwks(), policy, checkExpiry: !args.includes("--historic") });
    console.log(`✓ sealed box verified · ${r.claims.platform || "gcp-confidential-space"} · ${r.claims.hwmodel} · image ${r.claims.submods.container.image_digest}`);
    console.log(`  AI key ${ev.manifest.agent} · CometBFT key ${ev.manifest.cmtPubKey}`);
    console.log(`  attestHash ${r.attestHash}`);
  })().catch((e) => {
    console.error("✗ " + e.message);
    process.exitCode = 1;
  });
}
