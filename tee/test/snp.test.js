// AMD SEV-SNP verification against AMD's own root key — with a REAL SNP report and VCEK (test vectors from
// google/go-sev-guest, Apache-2.0) and AMD's official cert chains from kdsintf.amd.com — plus the Azure
// Confidential Containers evidence path.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const S = require("../snp.js");
const T = require("../verify.js");

const V = path.join(__dirname, "vectors");
const REPORT = fs.readFileSync(path.join(V, "snp-attestation.bin"));
const VCEK = fs.readFileSync(path.join(V, "snp-vcek.testcer"));
const MILAN = fs.readFileSync(path.join(V, "amd-milan-chain-official.pem"), "utf8");
const GENOA = fs.readFileSync(path.join(V, "amd-genoa-chain-official.pem"), "utf8");
const AT = new Date("2023-06-01");

test("a real SNP report verifies to AMD's Milan root key (signature + VCEK ← ASK ← ARK)", () => {
  const r = S.verifyReport(REPORT, { vcek: VCEK, chain: MILAN, at: AT, allowDebug: true });
  assert.equal(r.version, 2);
  assert.equal(r.measurement.length, 96);
});

test("this sample guest allows debugging, so it is refused by default (its owner could read it)", () => {
  assert.throws(() => S.verifyReport(REPORT, { vcek: VCEK, chain: MILAN, at: AT }), /allows debugging/);
});

test("tampering with the measurement, host data or report data breaks the signature", () => {
  for (const off of [0x90, 0xc0, 0x50]) {
    const bad = Buffer.from(REPORT);
    bad[off] ^= 1;
    assert.throws(() => S.verifyReport(bad, { vcek: VCEK, chain: MILAN, at: AT, allowDebug: true }), /signature invalid/);
  }
});

test("AMD roots are pinned per product: Milan and Genoa recognised, the wrong product refused", () => {
  assert.equal(S.productOf(MILAN), "Milan");
  assert.equal(S.productOf(GENOA), "Genoa");
  assert.throws(() => S.verifyReport(REPORT, { vcek: VCEK, chain: GENOA, product: "Milan", at: AT, allowDebug: true }), /AMD's Milan root key/);
});

// ---------- Azure Confidential Containers evidence path (SNP crypto stubbed: a real report can't carry our nonce)
const HOST = "cc".repeat(32), UVM = "dd".repeat(48);
const policy = { charterHash: T.charterHash(), promptHashes: null, hwmodels: [], imageDigests: [], azureAci: { hostData: [HOST], measurements: [UVM] } };
const vcekPem = new crypto.X509Certificate(VCEK).toString();
function manifest() {
  return { agt: "sealed-box-v1", chainId: "agt-1", charterHash: T.charterHash(), promptHash: ethers.id("p"), agent: ethers.Wallet.createRandom().address, cmtPubKey: crypto.randomBytes(32).toString("base64") };
}
function fakeSnp(reportData, host = HOST, uvm = UVM) {
  return { productOf: S.productOf, verifyReport: () => ({ hostData: host, measurement: uvm, reportData: reportData.padEnd(128, "0"), chipId: "ee".repeat(64), debugAllowed: false }) };
}
const bound = (m) => crypto.createHash("sha256").update(Buffer.from(T.nonceOf(m), "hex")).digest("hex");
const evidence = (m) => ({ platform: "azure-snp", manifest: m, report: "00", certChain: vcekPem + "\n" + MILAN });

test("Azure evidence: approved container policy + approved utility VM + report_data = sha256(nonce) → verified", () => {
  const m = manifest();
  const r = T.verifyEvidence(evidence(m), { policy, snp: fakeSnp(bound(m)) });
  assert.equal(r.claims.platform, "azure-snp");
  assert.equal(r.claims.hwmodel, "AMD_SEV_SNP_MILAN");
});

test("Azure evidence is refused for another container policy, another utility VM, or a swapped key", () => {
  const m = manifest();
  assert.throws(() => T.verifyEvidence(evidence(m), { policy, snp: fakeSnp(bound(m), "00".repeat(32)) }), /not an approved AGT box/);
  assert.throws(() => T.verifyEvidence(evidence(m), { policy, snp: fakeSnp(bound(m), HOST, "00".repeat(48)) }), /utility VM/);
  const other = { ...m, agent: ethers.Wallet.createRandom().address };
  assert.throws(() => T.verifyEvidence(evidence(other), { policy, snp: fakeSnp(bound(m)) }), /nonce mismatch/);
});
