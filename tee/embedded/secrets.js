// Client secrets for long-term work (THIET-KE-NGHE-NHUNG.md §5): a repository token, SSH deploy key, API key…
// The client seals the secret to the box's attested `clientPubKey` (from the manifest the licence was granted on).
// Only that sealed box can open it: not the AI's owner, not the AGT service, not the cloud.
//
// Scheme (also implementable with WebCrypto in a browser): X25519(ephemeral, clientPubKey) → HKDF-SHA256
// (salt = eph || clientPubKey, info = "agt-client-secret-v1") → AES-256-GCM with AAD = context.
// The context binds a secret to one engagement ("engagement:<chain>:<contract>:<id>"), so a secret given for
// one engagement cannot be replayed into another.
const crypto = require("crypto");

const INFO = "agt-client-secret-v1";
const b64 = (b) => Buffer.from(b).toString("base64");
const pubKey = (raw) => crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
const rawPub = (k) => Buffer.from(crypto.createPublicKey(k).export({ format: "jwk" }).x, "base64url");

function kdf(shared, eph, to) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([eph, to]), INFO, 32));
}

/// The client's side: seal `secret` (string) to the box. Returns a JSON-safe object.
function seal(clientPubKeyB64, secret, context) {
  if (!context) throw new Error("a context is required (which engagement this secret is for)");
  const to = Buffer.from(clientPubKeyB64, "base64");
  if (to.length !== 32) throw new Error("not an X25519 public key");
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const eph = rawPub(privateKey);
  const key = kdf(crypto.diffieHellman({ privateKey, publicKey: pubKey(to) }), eph, to);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(context));
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return { v: 1, context, eph: b64(eph), iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

/// The box's side: open with its `client` private key, only for the expected context.
function open(clientPriv, box, expectedContext) {
  if (!box || box.v !== 1) throw new Error("unknown sealed-secret format");
  if (box.context !== expectedContext) throw new Error("this secret was sealed for another engagement");
  const eph = Buffer.from(box.eph, "base64");
  const key = kdf(crypto.diffieHellman({ privateKey: clientPriv, publicKey: pubKey(eph) }), eph, rawPub(clientPriv));
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAAD(Buffer.from(box.context));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()]).toString();
}

const contextOf = (chainId, contract, id) => `engagement:${chainId}:${String(contract).toLowerCase()}:${id}`;

module.exports = { seal, open, contextOf, INFO };
