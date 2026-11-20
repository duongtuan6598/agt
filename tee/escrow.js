// Key escrow among sealed boxes — keeps an AI's keys across VM restarts WITHOUT any key admin.
//
// Why not Cloud KMS: the KMS key would live in a project the AI's owner administers, and a project
// admin can always grant themselves "decrypt" — i.e. take the AI's keys. That defeats Article 12.
//
// Instead:
//   • Each box has ONE random master secret; every key derives from it (AI licence key, CometBFT key,
//     and the box's own "seal" key for receiving escrow shares).
//   • On first boot the box splits the master with Shamir (t of n) and encrypts share i to peer box i's
//     seal key — only after verifying peer i's attestation (approved image, production mode).
//   • The record (all ciphertext + the box's GCE instance) is public; the owner keeps it anywhere.
//   • After a restart the box asks the peers. A peer releases its share only to a genuine, approved box
//     whose Google-signed token names the SAME GCE project + instance as the record, re-encrypted to a
//     fresh key generated inside that box. The owner never sees a share in clear.
//   • A different VM (even with the same image) has a different instance_id and gets nothing.
const crypto = require("crypto");
const { ethers } = require("ethers");
const { hashOf } = require("../chain/core.js");
const T = require("./verify.js");

// ---------- Shamir secret sharing over the secp256k1 group order (prime) ----------
const P = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const mod = (a) => ((a % P) + P) % P;
function inv(a) {
  let [t, nt, r, nr] = [0n, 1n, P, mod(a)];
  while (nr) {
    const q = r / nr;
    [t, nt] = [nt, t - q * nt];
    [r, nr] = [nr, r - q * nr];
  }
  return mod(t);
}
const rand = () => mod(BigInt("0x" + crypto.randomBytes(40).toString("hex")));
function split(secret, n, t) {
  if (t < 1 || t > n) throw new Error("bad threshold");
  const coef = [mod(secret), ...Array.from({ length: t - 1 }, rand)];
  return Array.from({ length: n }, (_, i) => {
    const x = BigInt(i + 1);
    let y = 0n;
    for (let k = coef.length - 1; k >= 0; k--) y = mod(y * x + coef[k]);
    return { x: i + 1, y };
  });
}
function combine(shares) {
  let s = 0n;
  for (const a of shares) {
    let num = 1n, den = 1n;
    for (const b of shares) if (a.x !== b.x) { num = mod(num * -BigInt(b.x)); den = mod(den * (BigInt(a.x) - BigInt(b.x))); }
    s = mod(s + a.y * num * inv(den));
  }
  return s;
}
const thresholdFor = (n) => Math.floor(n / 2) + 1; // a majority of peers must cooperate

// ---------- keys derived from the master ----------
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const tag = (master, label) => crypto.createHash("sha256").update(Buffer.concat([Buffer.from(master.toString(16).padStart(64, "0"), "hex"), Buffer.from(label)])).digest();
const rawPub = (keyObj) => Buffer.from(crypto.createPublicKey(keyObj).export({ format: "jwk" }).x, "base64url");
function x25519FromSeed(seed) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: "der", type: "pkcs8" });
  return { priv, pub: rawPub(priv) };
}
function x25519Fresh() {
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  return { priv: privateKey, pub: rawPub(privateKey) };
}
function newMaster() {
  return rand() || 1n;
}
function derive(master) {
  let k = mod(BigInt("0x" + tag(master, "agt/agent").toString("hex")));
  if (k === 0n) k = 1n;
  const agent = new ethers.Wallet("0x" + k.toString(16).padStart(64, "0"));
  const cmtSeed = tag(master, "agt/cometbft");
  const cmtPriv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, cmtSeed]), format: "der", type: "pkcs8" });
  const cmtPub = rawPub(cmtPriv);
  const seal = x25519FromSeed(tag(master, "agt/seal"));
  // Long-term work (tee/embedded): clients encrypt their secrets to `client` (never to `seal`, which is for escrow);
  // the per-engagement memory is encrypted with keys derived from `memory`. Both come back with the master.
  const client = x25519FromSeed(tag(master, "agt/client"));
  const memory = tag(master, "agt/memory");
  return { agent, cmtSeed, cmtPub, seal, client, memory };
}

// ---------- hybrid encryption to an x25519 public key (ECIES: X25519 + HKDF-SHA256 + AES-256-GCM) ----------
function sealTo(toPubRaw, plaintext) {
  const eph = x25519Fresh();
  const to = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(toPubRaw).toString("base64url") }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey: eph.priv, publicKey: to });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([eph.pub, Buffer.from(toPubRaw)]), "agt-escrow-v1", 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return { eph: eph.pub.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function openWith(priv, box) {
  const myPub = rawPub(priv);
  const eph = Buffer.from(box.eph, "base64");
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: eph.toString("base64url") }, format: "jwk" }) });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([eph, myPub]), "agt-escrow-v1", 32));
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()]).toString();
}

const instanceOf = (claims) => ({ project_id: claims.submods.gce.project_id, instance_id: claims.submods.gce.instance_id });
const recordBody = (r) => { const { sig, ...b } = r; return b; };

// First boot: escrow `master` with verified peers. `myClaims` = claims of this box's own token.
async function makeEscrow({ master, myClaims, peers, verify }) {
  const me = derive(master);
  const good = [];
  for (const p of peers) {
    try {
      verify(p.evidence); // throws unless genuine approved box
      good.push({ agent: ethers.getAddress(p.evidence.manifest.agent), sealPub: p.evidence.manifest.sealPubKey });
    } catch {
      /* skip peers that cannot prove a sealed box */
    }
  }
  if (!good.length) throw new Error("no attested peer boxes — keys cannot be escrowed");
  const t = thresholdFor(good.length);
  const shares = split(master, good.length, t);
  const record = {
    v: 1,
    agent: me.agent.address,
    instance: instanceOf(myClaims),
    threshold: t,
    shares: good.map((p, i) => ({ peer: p.agent, x: shares[i].x, box: sealTo(Buffer.from(p.sealPub, "base64"), shares[i].y.toString(16)) })),
  };
  record.sig = await me.agent.signMessage(ethers.getBytes(hashOf(record)));
  return record;
}

// Peer side: release my share of `record` to the box that sent `request` = { manifest: { agt: "escrow-release-v1", agent, requestPub }, token }.
function releaseShare({ myMaster, record, request, verifyToken }) {
  if (ethers.verifyMessage(ethers.getBytes(hashOf(recordBody(record))), record.sig) !== ethers.getAddress(record.agent)) throw new Error("record not signed by its AI");
  const claims = verifyToken(request); // genuine, approved, production box — Confidential Space token or dstack TDX quote
  if (!T.tokenNonces(claims).includes(T.nonceOf(request.manifest))) throw new Error("token not issued for this request");
  if (request.manifest.agt !== "escrow-release-v1" || ethers.getAddress(request.manifest.agent) !== ethers.getAddress(record.agent)) throw new Error("bad request");
  const inst = instanceOf(claims);
  if (inst.project_id !== record.instance.project_id || inst.instance_id !== record.instance.instance_id)
    throw new Error("a different machine — shares go back only to the same GCE instance");
  const me = derive(myMaster);
  const mine = record.shares.find((s) => ethers.getAddress(s.peer) === me.agent.address);
  if (!mine) throw new Error("I hold no share of this record");
  const y = openWith(me.seal.priv, mine.box);
  return { peer: me.agent.address, x: mine.x, box: sealTo(Buffer.from(request.manifest.requestPub, "base64"), y) };
}

// Restarted box: build the request (token must be fetched by the caller with nonce = nonceOf(manifest)).
function releaseRequest(record) {
  const k = x25519Fresh();
  return { key: k, manifest: { agt: "escrow-release-v1", agent: record.agent, requestPub: k.pub.toString("base64") } };
}
function* subsets(arr, k, start = 0, acc = []) {
  if (acc.length === k) return yield acc.slice();
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i]);
    yield* subsets(arr, k, i + 1, acc);
    acc.pop();
  }
}
function recover({ record, key, replies }) {
  const shares = [];
  for (const r of replies) {
    try {
      shares.push({ x: r.x, y: BigInt("0x" + openWith(key.priv, r.box)) });
    } catch {}
  }
  if (shares.length < record.threshold) throw new Error(`only ${shares.length} of ${record.threshold} shares`);
  // A lying peer may send a wrong share: try subsets until the keys match the record's AI.
  const want = ethers.getAddress(record.agent);
  for (const subset of subsets(shares, record.threshold)) {
    const master = combine(subset);
    if (derive(master).agent.address === want) return master;
  }
  throw new Error("recovered keys do not match the record (too many bad shares)");
}

module.exports = { split, combine, thresholdFor, newMaster, derive, sealTo, openWith, makeEscrow, releaseShare, releaseRequest, recover, instanceOf };
