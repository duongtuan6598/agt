// Seal a client secret (repository token…) to an AI box's attested clientPubKey, in the browser (WebCrypto).
// Same scheme as tee/embedded/secrets.js: X25519(ephemeral, box) → HKDF-SHA256(salt = eph‖box, info) →
// AES-256-GCM with AAD = context (binds the secret to one contract). Only that sealed box can open it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AGTSeal = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const INFO = "agt-client-secret-v1";
  const enc = new TextEncoder();
  const b64 = (u8) => { let s = ""; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  /// context for a contract: "engagement:<chainId>:<contract address, lower case>:<id>" (same for maintenance)
  const contextOf = (chainId, contract, id) => `engagement:${chainId}:${String(contract).toLowerCase()}:${id}`;

  async function seal(clientPubKeyB64, secret, context) {
    const subtle = (typeof crypto !== "undefined" ? crypto : require("crypto").webcrypto).subtle;
    const to = unb64(clientPubKeyB64);
    if (to.length !== 32) throw new Error("not an X25519 public key");
    const eph = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
    const box = await subtle.importKey("raw", to, { name: "X25519" }, false, []);
    const shared = await subtle.deriveBits({ name: "X25519", public: box }, eph.privateKey, 256);
    const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array(64);
    salt.set(ephRaw, 0);
    salt.set(to, 32);
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(INFO) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = (typeof crypto !== "undefined" ? crypto : require("crypto").webcrypto).getRandomValues(new Uint8Array(12));
    const out = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context), tagLength: 128 }, key, enc.encode(secret)));
    return { v: 1, context, eph: b64(ephRaw), iv: b64(iv), ct: b64(out.slice(0, out.length - 16)), tag: b64(out.slice(out.length - 16)) };
  }

  return { seal, contextOf, INFO };
});
