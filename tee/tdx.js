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
//   7. (with collateral) TCB level: the chip's SGX/TDX component SVNs from the PCK certificate and the TD's
//      TEE_TCB_SVN against Intel's SIGNED TCB info → UpToDate / SWHardeningNeeded / OutOfDate / Revoked …;
//      the QE's ISVSVN against Intel's signed QE identity; PCK and intermediate not on Intel's signed CRLs.
const crypto = require("crypto");
const DER = require("./der.js");

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

// ---------- TCB evaluation (Intel's signed collateral) ----------
const SGX_EXT = "1.2.840.113741.1.13.1";
// FMSPC, PCE-ID and the SGX TCB (16 component SVNs + PCESVN) from a PCK certificate.
function pckTcb(pckPem) {
  const ext = DER.extensions(new crypto.X509Certificate(pckPem).raw)[SGX_EXT];
  if (!ext) throw new Error("PCK certificate has no SGX extension");
  const out = { comps: [] };
  for (const e of DER.node(ext).children) {
    const id = DER.oid(e.children[0].value), v = e.children[1];
    if (id === `${SGX_EXT}.4`) out.fmspc = hex(v.value);
    if (id === `${SGX_EXT}.3`) out.pceId = hex(v.value);
    if (id === `${SGX_EXT}.2`) for (const c of v.children) {
      const sub = DER.oid(c.children[0].value).split(".").pop();
      const n = Number(sub);
      if (n >= 1 && n <= 16) out.comps[n - 1] = Number(DER.int(c.children[1].value));
      if (n === 17) out.pceSvn = Number(DER.int(c.children[1].value));
    }
  }
  return out;
}

// An Intel-signed collateral document: {"<key>":{…},"signature":"<hex>"}, signed by the TCB signing cert.
function signedBody(jsonText, key, chainPems, at) {
  const certs = verifyChain(chainPems, at, 2);
  const m = jsonText.match(new RegExp(`"${key}"\\s*:\\s*(\\{[\\s\\S]*\\})\\s*,\\s*"signature"\\s*:\\s*"([0-9a-f]+)"`));
  if (!m) throw new Error(`bad ${key} document`);
  if (!ecdsaOk(Buffer.from(m[1]), certs[0].publicKey, Buffer.from(m[2], "hex"))) throw new Error(`${key} not signed by Intel`);
  const body = JSON.parse(m[1]);
  if (body.nextUpdate && new Date(body.nextUpdate) < at) throw new Error(`${key} collateral expired on ${body.nextUpdate} — fetch fresh collateral from Intel`);
  return body;
}

// Intel's TCB-level matching: the first (highest) level that the platform meets or exceeds.
function tcbStatus(pck, teeTcbSvn, tcbInfo) {
  if (pck.fmspc.toLowerCase() !== String(tcbInfo.fmspc).toLowerCase()) throw new Error("TCB info is for another platform (FMSPC)");
  if (pck.pceId.toLowerCase() !== String(tcbInfo.pceId).toLowerCase()) throw new Error("TCB info is for another PCE");
  const tee = Buffer.from(teeTcbSvn, "hex");
  for (const lvl of tcbInfo.tcbLevels) {
    const sgxOk = lvl.tcb.sgxtcbcomponents.every((c, i) => (pck.comps[i] || 0) >= c.svn) && pck.pceSvn >= lvl.tcb.pcesvn;
    const tdxOk = (lvl.tcb.tdxtcbcomponents || []).every((c, i) => tee[i] >= c.svn);
    if (sgxOk && tdxOk) return { status: lvl.tcbStatus, date: lvl.tcbDate, advisories: lvl.advisoryIDs || [] };
  }
  return { status: "OutOfDate", date: null, advisories: [] }; // below every listed level
}

function revokedBy(crlDer, issuerCert, serialHex, at) {
  const c = DER.crl(crlDer);
  if (!crypto.verify("sha256", c.tbs, issuerCert.publicKey, c.signature)) throw new Error("CRL not signed by its issuer");
  if (c.nextUpdate && c.nextUpdate < at) throw new Error("CRL expired — fetch a fresh one from Intel");
  return c.revoked.includes(BigInt("0x" + serialHex));
}

const ACCEPT_TCB = ["UpToDate", "SWHardeningNeeded"];

// Verify a TDX quote; returns the parsed TD report body. Throws on any failure.
// collateral (optional, from Intel PCS): { tcbInfo:{json,chain}, qeIdentity:{json,chain}, crl:{platform, root} }
function verifyQuote(quote, { at = new Date(), qeIdentity = null, collateral = null, acceptTcb = ACCEPT_TCB, allowDebug = false } = {}) {
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
  let tcb = null;
  if (collateral) {
    // Revocation: the PCK must not be on the platform CA's CRL, the platform CA not on the root CRL.
    if (collateral.crl) {
      if (revokedBy(collateral.crl.platform, certs[1], certs[0].serialNumber, at)) throw new Error("PCK certificate revoked by Intel");
      if (collateral.crl.root && revokedBy(collateral.crl.root, certs[2], certs[1].serialNumber, at)) throw new Error("Intel platform CA revoked");
    }
    // Patch level of the platform and the TDX module.
    const info = signedBody(collateral.tcbInfo.json, "tcbInfo", collateral.tcbInfo.chain, at);
    if (info.id !== "TDX") throw new Error("collateral is not TDX TCB info");
    tcb = tcbStatus(pckTcb(q.pems[0]), q.body.teeTcbSvn, info);
    if (!acceptTcb.includes(tcb.status)) throw new Error(`platform TCB is ${tcb.status} — patches missing (${tcb.advisories.join(", ") || "see Intel advisories"})`);
    // Patch level of the quoting enclave.
    const qeId = signedBody(collateral.qeIdentity.json, "enclaveIdentity", collateral.qeIdentity.chain, at);
    checkQeIdentity(q.qe.report, collateral.qeIdentity.json, collateral.qeIdentity.chain, at);
    const isvsvn = q.qe.report.readUInt16LE(258);
    const ql = qeId.tcbLevels.find((l) => isvsvn >= l.tcb.isvsvn);
    const qeStatus = ql ? ql.tcbStatus : "OutOfDate";
    if (!acceptTcb.includes(qeStatus)) throw new Error(`quoting enclave TCB is ${qeStatus}`);
    tcb.qe = qeStatus;
  }
  return { ...q.body, debug, tcb, fmspcChain: certs.map((c) => c.subject.split("\n").find((l) => l.startsWith("CN="))) };
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

module.exports = { INTEL_ROOT_SHA256, ACCEPT_TCB, parseQuote, verifyChain, verifyQuote, checkQeIdentity, pckTcb, tcbStatus, signedBody, revokedBy, eventDigest, checkRtmr3, DSTACK_EVENT };
