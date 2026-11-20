// Intel TDX verification against Intel's own root — with a REAL TDX quote (test vector from
// automata-network/dcap-rs, Apache-2.0) — plus dstack RTMR3 replay and the full dstack evidence path.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const X = require("../tdx.js");
const T = require("../verify.js");
const E = require("../escrow.js");

const V = path.join(__dirname, "vectors");
const QUOTE = fs.readFileSync(path.join(V, "quote_tdx_00806f050000.dat"));
const AT = new Date("2024-06-01"); // within the vector's certificate validity
const pems = (f) => fs.readFileSync(path.join(V, f), "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);

test("a real TDX quote verifies all the way to Intel's root certificate", () => {
  const r = X.verifyQuote(QUOTE, { at: AT });
  assert.equal(r.debug, false);
  assert.deepEqual(r.fmspcChain, ["CN=Intel SGX PCK Certificate", "CN=Intel SGX PCK Platform CA", "CN=Intel SGX Root CA"]);
  assert.equal(r.mrTd.length, 96);
});

test("the root is pinned: Intel's official root certificate has the pinned fingerprint", () => {
  const official = new crypto.X509Certificate(fs.readFileSync(path.join(V, "intel-root-official.pem")));
  assert.equal(official.fingerprint256, X.INTEL_ROOT_SHA256);
  const q = X.parseQuote(QUOTE);
  assert.throws(() => X.verifyChain([q.pems[0], q.pems[1], q.pems[1]], AT), /Intel SGX Root CA/);
});

test("any change to the TD report breaks the quote signature", () => {
  for (const off of [48 + 136, 48 + 472, 48 + 520]) { // MRTD, RTMR3, report_data
    const bad = Buffer.from(QUOTE);
    bad[off] ^= 1;
    assert.throws(() => X.verifyQuote(bad, { at: AT }), /quote signature invalid/);
  }
});

test("QE identity is checked against Intel's signed collateral; a forged identity fails", () => {
  const json = fs.readFileSync(path.join(V, "qeidentityv2_apiv4.json"), "utf8");
  X.verifyQuote(QUOTE, { at: AT, qeIdentity: { json, chain: pems("tcb_signing_cert.pem") } });
  const forged = json.replace(/"mrsigner":"[0-9A-F]+"/, `"mrsigner":"${"00".repeat(32)}"`);
  assert.throws(() => X.verifyQuote(QUOTE, { at: AT, qeIdentity: { json: forged, chain: pems("tcb_signing_cert.pem") } }), /not signed by Intel/);
});

// ---------- dstack RTMR3 ----------
const ev = (event, payloadHex, version) => {
  const e = { imr: 3, event_type: X.DSTACK_EVENT, event, event_payload: payloadHex, version };
  e.digest = X.eventDigest(e).toString("hex");
  return e;
};
const replay = (events) => events.reduce((mr, e) => crypto.createHash("sha384").update(Buffer.concat([mr, Buffer.from(e.digest, "hex")])).digest(), Buffer.alloc(48)).toString("hex");
const COMPOSE = "ab".repeat(32);
const LOG = [ev("app-id", "11".repeat(20)), ev("compose-hash", COMPOSE, 2), ev("instance-id", "22".repeat(20)), ev("boot-mr-done", "")];

test("RTMR3 replays from the event log (v1 and v2 digests, as in dstack's Rust code)", () => {
  const got = X.checkRtmr3(LOG, replay(LOG));
  assert.equal(got["compose-hash"], COMPOSE);
  assert.equal(got["instance-id"], "22".repeat(20));
  const v1 = Buffer.concat([Buffer.from([1, 0, 0, 8]), Buffer.from(":app-id:"), Buffer.from("11".repeat(20), "hex")]);
  assert.equal(LOG[0].digest, crypto.createHash("sha384").update(v1).digest("hex"));
});

test("a forged compose hash or a reordered log does not replay to RTMR3", () => {
  const forged = LOG.map((e) => (e.event === "compose-hash" ? { ...e, event_payload: "cd".repeat(32) } : e));
  assert.throws(() => X.checkRtmr3(forged, replay(LOG)), /digest does not match/);
  assert.throws(() => X.checkRtmr3([LOG[1], LOG[0], LOG[2], LOG[3]], replay(LOG)), /RTMR3 does not match/);
});

// ---------- full dstack evidence path (quote crypto stubbed: the real quote cannot carry our nonce) ----------
const OS = { mrTd: "aa".repeat(48), rtmr0: "b0".repeat(48), rtmr1: "b1".repeat(48), rtmr2: "b2".repeat(48) };
const policy = { charterHash: T.charterHash(), promptHashes: null, hwmodels: [], imageDigests: [], dstack: { osImages: [OS], composeHashes: [COMPOSE] } };
function fakeTdx(reportDataHex, events = LOG, os = OS) {
  return { verifyQuote: () => ({ ...os, rtmr3: replay(events), reportData: reportDataHex.padEnd(128, "0"), debug: false }), checkRtmr3: X.checkRtmr3 };
}
function box(instance = "22".repeat(20)) {
  const master = E.newMaster();
  const k = E.derive(master);
  const manifest = { agt: "sealed-box-v1", chainId: "agt-1", charterHash: T.charterHash(), promptHash: ethers.id("p"), agent: k.agent.address, cmtPubKey: k.cmtPub.toString("base64"), sealPubKey: k.seal.pub.toString("base64") };
  const log = [LOG[0], LOG[1], ev("instance-id", instance), LOG[3]];
  return { master, k, manifest, log, evidence: { platform: "dstack-tdx", manifest, quote: "00", eventLog: log } };
}

test("dstack evidence: approved OS + approved compose + nonce = manifest → verified, with the instance id", () => {
  const b = box();
  const r = T.verifyEvidence(b.evidence, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(b.manifest), b.log) });
  assert.equal(r.claims.platform, "dstack-tdx");
  assert.equal(r.claims.submods.gce.instance_id, "22".repeat(20));
  assert.match(r.attestHash, /^0x[0-9a-f]{64}$/);
});

test("dstack evidence is refused for an unapproved compose, an unapproved OS, or a swapped key", () => {
  const b = box();
  const other = [LOG[0], ev("compose-hash", "ee".repeat(32), 2), LOG[2], LOG[3]];
  assert.throws(() => T.verifyEvidence({ ...b.evidence, eventLog: other }, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(b.manifest), other) }), /not an approved AGT box/);
  assert.throws(() => T.verifyEvidence(b.evidence, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(b.manifest), b.log, { ...OS, mrTd: "00".repeat(48) }) }), /not an approved release/);
  const swapped = { ...b.evidence, manifest: { ...b.manifest, agent: ethers.Wallet.createRandom().address } };
  assert.throws(() => T.verifyEvidence(swapped, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(b.manifest), b.log) }), /nonce mismatch/);
});

test("escrow works across platforms: a dstack box gets its keys back only on the same dstack instance", async () => {
  const a = box("33".repeat(20));
  const peers = [box("44".repeat(20)), box("55".repeat(20))];
  const verifyEv = (e) => T.verifyEvidence(e, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(e.manifest), e.eventLog) });
  const myClaims = T.verifyEvidence(a.evidence, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(a.manifest), a.log) }).claims;
  const record = await E.makeEscrow({ master: a.master, myClaims, peers: peers.map((p) => ({ evidence: p.evidence })), verify: verifyEv });
  const ask = (instance) => {
    const req = E.releaseRequest(record);
    const log = [LOG[0], LOG[1], ev("instance-id", instance), LOG[3]];
    const request = { platform: "dstack-tdx", manifest: req.manifest, quote: "00", eventLog: log };
    const verifyToken = (r) => T.verifyAttestation(r, { policy, collateral: { intel: {} }, tdx: fakeTdx(T.nonceOf(r.manifest), r.eventLog) });
    const replies = [], errors = [];
    for (const p of peers) {
      try { replies.push(E.releaseShare({ myMaster: p.master, record, request, verifyToken })); } catch (e) { errors.push(e.message); }
    }
    return { req, replies, errors };
  };
  const same = ask("33".repeat(20));
  assert.equal(E.derive(E.recover({ record, key: same.req.key, replies: same.replies })).agent.address, a.k.agent.address);
  const other = ask("99".repeat(20));
  assert.equal(other.replies.length, 0);
  assert.match(other.errors[0], /different machine/);
});
