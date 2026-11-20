// Patch level (TCB) and revocation, with REAL vendor-signed collateral:
//   Intel: TDX TCB info + TD QE identity + PCK CRL + root CRL (vectors from automata-network/dcap-rs)
//   AMD:   VCEK TCB extensions vs the report, and the Milan CRL from kdsintf.amd.com
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const X = require("../tdx.js");
const S = require("../snp.js");
const D = require("../der.js");
const T = require("../verify.js");

const V = path.join(__dirname, "vectors");
const rd = (f, enc) => fs.readFileSync(path.join(V, f), enc);
const pems = (t) => t.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
const QUOTE = rd("quote_tdx_00806f050000.dat");
const SIGN = pems(rd("tcb_signing_cert.pem", "utf8"));
const COL = {
  tcbInfo: { json: rd("tcbinfov3_00806f050000.json", "utf8"), chain: SIGN },
  qeIdentity: { json: rd("qeidentityv2_apiv4.json", "utf8"), chain: SIGN },
  crl: { platform: rd("pck_platform_crl.der"), root: rd("intel_root_ca_crl.der") },
};
const AT = new Date("2025-03-01"); // inside the collateral's validity window

test("Intel: the real chip is OutOfDate — refused, naming Intel's security advisories", () => {
  assert.throws(() => X.verifyQuote(QUOTE, { at: AT, collateral: COL }), /OutOfDate — patches missing \(INTEL-SA-00960/);
});

test("Intel: the PCK certificate's own TCB is read (16 SGX components + PCESVN, FMSPC matches the TCB info)", () => {
  const t = X.pckTcb(X.parseQuote(QUOTE).pems[0]);
  assert.equal(t.fmspc, "00806f050000");
  assert.equal(t.comps.length, 16);
  assert.equal(t.pceSvn, 11);
});

test("Intel: with a lenient policy the levels are still evaluated; the quoting enclave is UpToDate", () => {
  const r = X.verifyQuote(QUOTE, { at: AT, collateral: COL, acceptTcb: ["UpToDate", "SWHardeningNeeded", "OutOfDate"] });
  assert.equal(r.tcb.status, "OutOfDate");
  assert.equal(r.tcb.qe, "UpToDate");
});

test("Intel: a TCB info rewritten to say UpToDate is caught (signature), and so is expired collateral", () => {
  const forged = COL.tcbInfo.json.replace(/"tcbStatus":"OutOfDate"/g, '"tcbStatus":"UpToDate"');
  assert.throws(() => X.verifyQuote(QUOTE, { at: AT, collateral: { ...COL, tcbInfo: { json: forged, chain: SIGN } } }), /not signed by Intel/);
  assert.throws(() => X.verifyQuote(QUOTE, { at: new Date("2025-06-01"), collateral: COL }), /expired/);
});

test("Intel: revocation — a certificate on Intel's signed CRL is detected; the CRL's signature is checked", () => {
  const platformCa = new crypto.X509Certificate(X.parseQuote(QUOTE).pems[1]);
  const crl = D.crl(COL.crl.platform);
  const revoked = crl.revoked[0].toString(16);
  assert.equal(X.revokedBy(COL.crl.platform, platformCa, revoked, AT), true);
  assert.equal(X.revokedBy(COL.crl.platform, platformCa, "01", AT), false);
  const bad = Buffer.from(COL.crl.platform);
  bad[60] ^= 1;
  assert.throws(() => X.revokedBy(bad, platformCa, "01", AT));
});

// ---------- AMD ----------
const REPORT = rd("snp-attestation.bin");
const VCEK = rd("snp-vcek.testcer");
const MILAN = rd("amd-milan-chain-official.pem", "utf8");
const CRL = rd("amd-milan-crl.der");
const NOW = new Date("2026-11-20");

test("AMD: the VCEK is bound to this chip and this TCB; the ASK is not on AMD's signed CRL", () => {
  const r = S.verifyReport(REPORT, { vcek: VCEK, chain: MILAN, at: NOW, allowDebug: true, crl: CRL });
  assert.deepEqual(r.tcb, { bootloader: 2, tee: 0, snp: 5, microcode: 68 });
  assert.equal(S.vcekTcb(VCEK).hwId, S.parseReport(REPORT).chipId);
});

test("AMD: a TCB below the policy minimum is refused (firmware patches missing)", () => {
  assert.throws(() => S.verifyReport(REPORT, { vcek: VCEK, chain: MILAN, at: NOW, allowDebug: true, minTcb: { snp: 6 } }), /snp SPL 5 is below the required 6/);
});

test("AMD: a tampered CRL fails its RSA-PSS signature by the ARK", () => {
  const bad = Buffer.from(CRL);
  bad[40] ^= 1;
  assert.throws(() => S.verifyReport(REPORT, { vcek: VCEK, chain: MILAN, at: NOW, allowDebug: true, crl: bad }), /not signed by the ARK|CRL/);
});

test("without the vendor's collateral, chip-vendor evidence is refused", () => {
  const policy = { charterHash: T.charterHash(), hwmodels: [], imageDigests: [], dstack: { osImages: [], composeHashes: [] }, azureAci: { hostData: [], measurements: [] } };
  assert.throws(() => T.verifyEvidence({ platform: "dstack-tdx", manifest: {}, quote: "00", eventLog: "[]" }, { policy }), /Intel collateral .* is required/);
  assert.throws(() => T.verifyEvidence({ platform: "azure-snp", manifest: {}, report: "00", certChain: "" }, { policy }), /AMD CRL is required/);
});
