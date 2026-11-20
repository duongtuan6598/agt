// Intel TDX quote verification, checked directly against Intel's root certificate — no cloud provider
// in the trust path (Charter Article 13). Used for sealed boxes running on dstack (open-source TDX OS that
// runs on any TDX server), where the app's docker-compose hash is measured into RTMR3.
//
// What is verified:
//   1. PCK certificate chain (leaf → Intel platform/processor CA → Intel SGX Root CA, pinned by fingerprint)
//   2. QE report signed by the PCK key; QE report binds the attestation key (sha256(attKey || qeAuth))
//   3. QE identity: QE report MRSIGNER/ISVPRODID match Intel's signed QE identity (optional collateral)
//   4. Quote signed by the attestation key (header || TD report)
//   5. TD is not in debug mode
//   6. RTMR3 equals the replay of the dstack runtime event log → the compose-hash event is genuine
// Not yet verified (TODO before mainnet): TCB level against Intel TCB info (patch status), CRL revocation.
const crypto = require("crypto");

const INTEL_ROOT_SHA256 = "44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3";
const TDX_TEE = 0x81;
const HEADER = 48, BODY = 584;
const hex = (b) => Buffer.from(b).toString("hex");

function parseQuote(q) {
  q = Buffer.isBuffer(q) ? q : Buffer.from(String(q).replace(/^0x/, ""), "hex");
  const header = {
    version: q.readUInt16LE(0),
    attKeyType: q.readUInt16LE(2),
    teeType: q.readUInt32LE(4),
    qeVendorId: hex(q.subarray(12, 28)),
  };
  if (header.version !== 4) throw new Error(`unsupported quote version ${header.version}`);
  if (header.teeType !== TDX_TEE) throw new Error("not a TDX quote");
  if (header.attKeyType !== 2) throw new Error("attestation key is not ECDSA P-256");
  const b = q.subarray(HEADER, HEADER + BODY);
  const f = (o, n) => hex(b.subarray(o, o + n));
  const body = {
    teeTcbSvn: f(0, 16), mrSeam: f(16, 48), mrSignerSeam: f(64, 48), seamAttributes: f(112, 8),
    tdAttributes: f(120, 8), xfam: f(128, 8), mrTd: f(136, 48), mrConfigId: f(184, 48), mrOwner: f(232, 48),
    mrOwnerConfig: f(280, 48), rtmr0: f(328, 48), rtmr1: f(376, 48), rtmr2: f(424, 48), rtmr3: f(472, 48),
    reportData: f(520, 64),
  };
  const sigLen = q.readUInt32LE(HEADER + BODY);
  const sd = q.subarray(HEADER + BODY + 4, HEADER + BODY + 4 + sigLen);
  const sig = sd.subarray(0, 64), attKey = sd.subarray(64, 128);
  let certType = sd.readUInt16LE(128), certSize = sd.readUInt32LE(130), cert = sd.subarray(134, 134 + certSize);
  let qe = null;
  if (certType === 6) {
    // QE report certification data: QE report (384) || sig (64) || auth size (2) || auth || nested cert data
    const qeReport = cert.subarray(0, 384), qeReportSig = cert.subarray(384, 448);
    const authSize = cert.readUInt16LE(448);
    const qeAuth = cert.subarray(450, 450 + authSize);
    const o = 450 + authSize;
    certType = cert.readUInt16LE(o);
    certSize = cert.readUInt32LE(o + 2);
    qe = { report: qeReport, sig: qeReportSig, auth: qeAuth };
    cert = cert.subarray(o + 6, o + 6 + certSize);
  }
  if (certType !== 5) throw new Error(`unsupported certification data type ${certType}`);
  const pems = cert.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  return { raw: q, header, body, signed: q.subarray(0, HEADER + BODY), sig, attKey, qe, pems };
}

const p256Raw = (raw) => crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(0, 32).toString("base64url"), y: raw.subarray(32, 64).toString("base64url") }, format: "jwk" });
const ecdsaOk = (data, key, sig) => crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);

function verifyChain(pems, at = new Date(), min = 3) {
  if (pems.length < min) throw new Error("certificate chain incomplete");
  const certs = pems.map((p) => new crypto.X509Certificate(p));
  const root = certs[certs.length - 1];
  if (root.fingerprint256 !== INTEL_ROOT_SHA256) throw new Error("chain does not end at Intel SGX Root CA");
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i], issuer = certs[Math.min(i + 1, certs.length - 1)];
    if (!c.verify(issuer.publicKey)) throw new Error(`certificate ${i} not signed by its issuer`);
    if (new Date(c.validFrom) > at || new Date(c.validTo) < at) throw new Error(`certificate ${i} not valid at ${at.toISOString()}`);
  }
  return certs;
}

// Optional: Intel-signed QE identity JSON (from Intel PCS), with its TCB signing chain.
function checkQeIdentity(qeReport, identityJsonText, signingChainPems, at) {
  const certs = verifyChain(signingChainPems, at, 2);
  const m = identityJsonText.match(/"enclaveIdentity"\s*:\s*(\{[\s\S]*\})\s*,\s*"signature"\s*:\s*"([0-9a-f]+)"/);
  if (!m) throw new Error("bad QE identity document");
  if (!ecdsaOk(Buffer.from(m[1]), certs[0].publicKey, Buffer.from(m[2], "hex"))) throw new Error("QE identity not signed by Intel");
  const id = JSON.parse(m[1]);
  const mrsigner = hex(qeReport.subarray(128, 160)).toUpperCase();
  const isvProdId = qeReport.readUInt16LE(256);
  if (mrsigner !== String(id.mrsigner).toUpperCase()) throw new Error("QE MRSIGNER is not Intel's");
  if (isvProdId !== id.isvprodid) throw new Error("QE ISVPRODID mismatch");
  return id;
}

// Verify a TDX quote; returns the parsed TD report body. Throws on any failure.
function verifyQuote(quote, { at = new Date(), qeIdentity = null, allowDebug = false } = {}) {
  const q = parseQuote(quote);
  const certs = verifyChain(q.pems, at);
  if (!q.qe) throw new Error("quote has no QE report");
  if (!ecdsaOk(q.qe.report, certs[0].publicKey, q.qe.sig)) throw new Error("QE report not signed by the PCK key");
  const bind = crypto.createHash("sha256").update(Buffer.concat([q.attKey, q.qe.auth])).digest();
  const rd = q.qe.report.subarray(320, 384);
  if (!rd.subarray(0, 32).equals(bind) || !rd.subarray(32).equals(Buffer.alloc(32))) throw new Error("QE report does not bind the attestation key");
  if (qeIdentity) checkQeIdentity(q.qe.report, qeIdentity.json, qeIdentity.chain, at);
  if (!ecdsaOk(q.signed, p256Raw(q.attKey), q.sig)) throw new Error("quote signature invalid");
  const debug = (Buffer.from(q.body.tdAttributes, "hex")[0] & 1) === 1;
  if (debug && !allowDebug) throw new Error("TD is in debug mode — its owner could read it");
  return { ...q.body, debug, fmspcChain: certs.map((c) => c.subject.split("\n").find((l) => l.startsWith("CN="))) };
}

// ---------- dstack runtime event log (RTMR3) ----------
const DSTACK_EVENT = 0x08000001;
function eventDigest(e) {
  const payload = Buffer.from(e.event_payload || "", "hex");
  if (e.version === 2) {
    const canonical = `{"name":${JSON.stringify(e.event)},"payload":"${payload.toString("hex")}","type":${DSTACK_EVENT}}`;
    return crypto.createHash("sha384").update(canonical).digest();
  }
  const t = Buffer.alloc(4);
  t.writeUInt32LE(DSTACK_EVENT);
  return crypto.createHash("sha384").update(Buffer.concat([t, Buffer.from(":"), Buffer.from(e.event), Buffer.from(":"), payload])).digest();
}

// Replays the RTMR3 events; every digest must match its (event, payload) and the result must equal rtmr3.
function checkRtmr3(eventLog, rtmr3Hex) {
  const events = (typeof eventLog === "string" ? JSON.parse(eventLog) : eventLog).filter((e) => e.imr === 3);
  let mr = Buffer.alloc(48);
  const out = {};
  for (const e of events) {
    const d = e.event_type === DSTACK_EVENT ? eventDigest(e) : Buffer.from(e.digest, "hex");
    if (e.event_type === DSTACK_EVENT && e.digest && d.toString("hex") !== e.digest.toLowerCase()) throw new Error(`event ${e.event}: digest does not match its payload`);
    mr = crypto.createHash("sha384").update(Buffer.concat([mr, d])).digest();
    if (e.event_type === DSTACK_EVENT) out[e.event] = e.event_payload;
  }
  if (mr.toString("hex") !== String(rtmr3Hex).toLowerCase()) throw new Error("RTMR3 does not match the event log");
  return out; // e.g. { "app-id": "...", "compose-hash": "...", "instance-id": "..." }
}

module.exports = { INTEL_ROOT_SHA256, parseQuote, verifyChain, verifyQuote, checkQeIdentity, eventDigest, checkRtmr3, DSTACK_EVENT };
