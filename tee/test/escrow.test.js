const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { ethers } = require("ethers");
const T = require("../verify.js");
const E = require("../escrow.js");

// We play Google's attestation service (own RSA key) and issue tokens for simulated boxes.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = [{ ...publicKey.export({ format: "jwk" }), kid: "k", alg: "RS256" }];
const IMAGE = "sha256:" + "cd".repeat(32);
const policy = { audience: T.AUDIENCE, hwmodels: ["GCP_AMD_SEV", "GCP_INTEL_TDX"], imageDigests: [IMAGE], charterHash: T.charterHash(), promptHashes: null };
function token(manifest, { instance = "111", project = "p1", image = IMAGE, dbg = "disabled-since-boot" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const c = {
    iss: T.ISSUER, aud: T.AUDIENCE, iat: now, nbf: now, exp: now + 3600, swname: "CONFIDENTIAL_SPACE", hwmodel: "GCP_AMD_SEV", dbgstat: dbg, secboot: true,
    submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: image, restart_policy: "Never" }, gce: { project_id: project, instance_id: instance } },
    eat_nonce: T.nonceOf(manifest),
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "RS256", kid: "k" }) + "." + enc(c);
  return h + "." + crypto.sign("RSA-SHA256", Buffer.from(h), privateKey).toString("base64url");
}
const verifyEv = (ev) => T.verifyEvidence(ev, { jwks, policy });
const verifyToken = (t) => T.verifyBoxToken(t, { jwks, policy });

// A box: master → keys → evidence (manifest carries its seal key so peers can escrow to it).
function box(instance) {
  const master = E.newMaster();
  const k = E.derive(master);
  const manifest = { agt: "sealed-box-v1", chainId: "agt-1", charterHash: T.charterHash(), promptHash: ethers.id("p"), agent: k.agent.address, cmtPubKey: k.cmtPub.toString("base64"), sealPubKey: k.seal.pub.toString("base64") };
  return { master, k, instance, evidence: { manifest, token: token(manifest, { instance }) } };
}
const claimsOf = (b) => JSON.parse(Buffer.from(b.evidence.token.split(".")[1], "base64url"));
async function setup(nPeers = 3) {
  const peers = Array.from({ length: nPeers }, (_, i) => box(String(200 + i)));
  const a = box("111");
  const record = await E.makeEscrow({ master: a.master, myClaims: claimsOf(a), peers: peers.map((p) => ({ evidence: p.evidence })), verify: verifyEv });
  return { a, peers, record };
}
function ask(peers, record, tokOpts = {}) {
  const req = E.releaseRequest(record);
  const request = { manifest: req.manifest, token: token(req.manifest, { instance: "111", ...tokOpts }) };
  const replies = [], errors = [];
  for (const p of peers) {
    try {
      replies.push(E.releaseShare({ myMaster: p.master, record, request, verifyToken }));
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { req, replies, errors };
}

test("Shamir: any t of n shares rebuild the secret, fewer do not", () => {
  const s = E.newMaster();
  const sh = E.split(s, 5, 3);
  assert.equal(E.combine([sh[0], sh[2], sh[4]]), s);
  assert.equal(E.combine([sh[1], sh[3], sh[4]]), s);
  assert.notEqual(E.combine([sh[0], sh[1]]), s);
});

test("the same master always gives the same AI key, CometBFT key and seal key", () => {
  const m = E.newMaster();
  assert.equal(E.derive(m).agent.address, E.derive(m).agent.address);
  assert.deepEqual(E.derive(m).cmtPub, E.derive(m).cmtPub);
  assert.deepEqual(E.derive(m).seal.pub, E.derive(m).seal.pub);
});

test("restart on the SAME machine: peers release shares and the box gets its exact keys back", async () => {
  const { a, peers, record } = await setup(3);
  assert.equal(record.threshold, 2);
  assert.ok(!JSON.stringify(record).includes(a.master.toString(16)), "the record holds no clear secret");
  const { req, replies } = ask(peers, record);
  const m = E.recover({ record, key: req.key, replies });
  assert.equal(E.derive(m).agent.address, a.k.agent.address);
  assert.deepEqual(E.derive(m).cmtPub, a.k.cmtPub);
});

test("a DIFFERENT machine, an unapproved image or a debug box gets nothing", async () => {
  const { peers, record } = await setup(3);
  for (const [opts, re] of [[{ instance: "999" }, /different machine/], [{ image: "sha256:" + "00".repeat(32) }, /approved AGT image/], [{ dbg: "enabled" }, /debug/]]) {
    const { replies, errors } = ask(peers, record, opts);
    assert.equal(replies.length, 0);
    assert.match(errors[0], re);
  }
});

test("the owner, holding the record but no sealed box, cannot open any share", async () => {
  const { record } = await setup(3);
  const ownerKey = E.releaseRequest(record).key; // any key the owner makes
  for (const s of record.shares) assert.throws(() => E.openWith(ownerKey.priv, s.box));
});

test("works with one peer offline or one peer lying; fails when too few answer", async () => {
  const { a, peers, record } = await setup(4); // threshold 3
  const { req, replies } = ask(peers.slice(0, 3), record); // peer 4 offline
  assert.equal(E.derive(E.recover({ record, key: req.key, replies })).agent.address, a.k.agent.address);
  const { req: req2, replies: r2 } = ask(peers, record);
  r2[1] = { ...r2[1], box: E.sealTo(Buffer.from(req2.manifest.requestPub, "base64"), "abcd") }; // one liar among 4
  assert.equal(E.derive(E.recover({ record, key: req2.key, replies: r2 })).agent.address, a.k.agent.address);
  assert.throws(() => E.recover({ record, key: req.key, replies: replies.slice(0, 2) }), /only 2 of 3/);
});

test("a peer that cannot prove a sealed box is never given a share", async () => {
  const good = box("201");
  const fake = box("202");
  fake.evidence = { ...fake.evidence, token: token(fake.evidence.manifest, { instance: "202", dbg: "enabled" }) };
  const a = box("111");
  const record = await E.makeEscrow({ master: a.master, myClaims: claimsOf(a), peers: [{ evidence: good.evidence }, { evidence: fake.evidence }], verify: verifyEv });
  assert.deepEqual(record.shares.map((s) => s.peer), [good.k.agent.address]);
});
