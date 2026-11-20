// AMD SEV-SNP attestation report verification, checked directly against AMD's root key (ARK) — no cloud
// provider in the trust path (Charter Article 13). With tee/tdx.js this gives AGT two chip vendors.
// Used for Azure Confidential Containers (ACI: the container policy hash is in HOST_DATA) and for any
// self-hosted SEV-SNP machine.
//
// Verified: VCEK ← ASK ← ARK chain (ARK pinned by fingerprint, per product), report signature (ECDSA P-384)
// by the VCEK, guest policy without debug; the VCEK is for THIS chip (hwID = chip_id) at THIS TCB
// (its TCB extensions = the report's reported_tcb); optional minimum TCB; ASK not on AMD's signed CRL.
const crypto = require("crypto");
const DER = require("./der.js");

// AMD Root Keys, from https://kdsintf.amd.com/vcek/v1/<product>/cert_chain (SHA-256 fingerprints).
const AMD_ARK = {
  Milan: "69:D0:63:B4:53:44:D2:6A:2E:94:E1:F4:21:0D:E4:9E:F5:55:30:82:87:D4:C1:74:44:5C:95:63:9A:54:0B:CD",
  Genoa: "4C:65:98:D1:9C:18:71:9C:5D:FD:4A:7D:33:5F:67:4E:5B:FE:1D:8F:80:0C:EA:2C:F2:70:C1:0D:10:3D:B2:F1",
};
// Which AMD product a chain belongs to (by its root's fingerprint), or null.
function productOf(askArkPem) {
  const certs = askArkPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  const ark = certs.length ? new crypto.X509Certificate(certs[certs.length - 1]) : null;
  return ark ? Object.keys(AMD_ARK).find((p) => AMD_ARK[p] === ark.fingerprint256) || null : null;
}
const REPORT_SIZE = 0x4a0;
const SIGNED = 0x2a0;
const hex = (b) => Buffer.from(b).toString("hex");

function parseReport(r) {
  r = Buffer.isBuffer(r) ? r : Buffer.from(String(r).replace(/^0x/, ""), "hex");
  if (r.length < REPORT_SIZE) throw new Error("SNP report too short");
  const policy = r.readBigUInt64LE(0x08);
  return {
    raw: r,
    version: r.readUInt32LE(0x00),
    guestSvn: r.readUInt32LE(0x04),
    policy,
    debugAllowed: ((policy >> 19n) & 1n) === 1n,
    vmpl: r.readUInt32LE(0x30),
    sigAlgo: r.readUInt32LE(0x34),
    signingKey: (r.readUInt32LE(0x48) >> 2) & 7, // 0 = VCEK, 1 = VLEK
    reportData: hex(r.subarray(0x50, 0x90)),
    measurement: hex(r.subarray(0x90, 0xc0)),
    hostData: hex(r.subarray(0xc0, 0xe0)),
    idKeyDigest: hex(r.subarray(0xe0, 0x110)),
    reportedTcb: r.readBigUInt64LE(0x180),
    chipId: hex(r.subarray(0x1a0, 0x1e0)),
    sig: { r: r.subarray(0x2a0, 0x2a0 + 72), s: r.subarray(0x2a0 + 72, 0x2a0 + 144) },
  };
}

// AMD stores r and s little-endian in 72-byte fields; P-384 uses the low 48 bytes.
function sigP1363(sig) {
  const be = (x) => Buffer.from(x.subarray(0, 48)).reverse();
  return Buffer.concat([be(sig.r), be(sig.s)]);
}

function verifyChain(vcekDer, askArkPem, product = "Milan", at = new Date()) {
  const [ask, ark] = askArkPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g).map((p) => new crypto.X509Certificate(p));
  if (!AMD_ARK[product] || ark.fingerprint256 !== AMD_ARK[product]) throw new Error(`chain does not end at AMD's ${product} root key`);
  const vcek = new crypto.X509Certificate(vcekDer);
  if (!ark.verify(ark.publicKey)) throw new Error("ARK is not self-signed");
  if (!ask.verify(ark.publicKey)) throw new Error("ASK not signed by ARK");
  if (!vcek.verify(ask.publicKey)) throw new Error("VCEK not signed by ASK");
  for (const [n, c] of [["VCEK", vcek], ["ASK", ask], ["ARK", ark]])
    if (new Date(c.validFrom) > at || new Date(c.validTo) < at) throw new Error(`${n} not valid at ${at.toISOString()}`);
  return vcek;
}

// TCB SPLs and chip id carried by a VCEK certificate (AMD KDS extensions).
function vcekTcb(vcekCert) {
  const ext = DER.extensions(new crypto.X509Certificate(vcekCert).raw);
  const spl = (n) => (ext[`1.3.6.1.4.1.3704.1.3.${n}`] ? Number(DER.int(DER.node(ext[`1.3.6.1.4.1.3704.1.3.${n}`]).value)) : null);
  const hw = ext["1.3.6.1.4.1.3704.1.4"];
  return { bootloader: spl(1), tee: spl(2), snp: spl(3), microcode: spl(8), hwId: hw ? Buffer.from(hw).toString("hex") : null };
}
// reported_tcb (Milan/Genoa layout): byte 0 bootloader, 1 TEE, 6 SNP, 7 microcode.
function splitTcb(tcb) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(tcb);
  return { bootloader: b[0], tee: b[1], snp: b[6], microcode: b[7] };
}
// AMD's CRL (RSA-PSS SHA-384, signed by the ARK) must not list the ASK.
function askRevoked(crlDer, ark, ask, at) {
  const c = DER.crl(crlDer);
  const ok = crypto.verify("sha384", c.tbs, { key: ark.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, c.signature);
  if (!ok) throw new Error("AMD CRL not signed by the ARK");
  if (c.nextUpdate && c.nextUpdate < at) throw new Error("AMD CRL expired — fetch a fresh one from AMD KDS");
  return c.revoked.includes(BigInt("0x" + ask.serialNumber));
}

// Verify an SNP report; returns its parsed fields. Throws on any failure.
// minTcb: { bootloader, tee, snp, microcode } minimum SPLs (from AMD security bulletins); crl: AMD CRL (DER).
function verifyReport(report, { vcek, chain, product = "Milan", at = new Date(), allowDebug = false, minTcb = null, crl = null }) {
  const r = parseReport(report);
  if (r.sigAlgo !== 1) throw new Error("report not signed with ECDSA P-384");
  const key = verifyChain(vcek, chain, product, at);
  const ok = crypto.verify("sha384", r.raw.subarray(0, SIGNED), { key: key.publicKey, dsaEncoding: "ieee-p1363" }, sigP1363(r.sig));
  if (!ok) throw new Error("report signature invalid");
  if (r.debugAllowed && !allowDebug) throw new Error("guest policy allows debugging — its owner could read it");
  // The VCEK must be THIS chip's key at THIS TCB: otherwise an old, vulnerable firmware's key could sign.
  const v = vcekTcb(vcek);
  const reported = splitTcb(r.reportedTcb);
  if (r.signingKey === 0) {
    if (v.hwId && v.hwId !== r.chipId) throw new Error("VCEK belongs to another chip");
    for (const k of ["bootloader", "tee", "snp", "microcode"])
      if (v[k] !== null && v[k] !== reported[k]) throw new Error(`VCEK is for ${k} SPL ${v[k]}, report says ${reported[k]}`);
  }
  if (minTcb) for (const k of Object.keys(minTcb)) if (reported[k] < minTcb[k]) throw new Error(`${k} SPL ${reported[k]} is below the required ${minTcb[k]} — firmware patches missing`);
  if (crl) {
    const [ask, ark] = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g).map((p) => new crypto.X509Certificate(p));
    if (askRevoked(crl, ark, ask, at)) throw new Error("AMD signing key (ASK) revoked");
  }
  const { raw, sig, ...fields } = r;
  return { ...fields, tcb: reported };
}

module.exports = { AMD_ARK, productOf, parseReport, verifyChain, verifyReport, vcekTcb, splitTcb, askRevoked, sigP1363 };
