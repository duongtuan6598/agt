// AGT's own signature form. A signature over a 32-byte AGT digest is made on
//   keccak256("\x19AGT Signed Message:\n32" ‖ digest)
// and written "agt:0x…" (65 bytes, r‖s‖v). It can never be replayed as a message of another chain's wallet, and a
// wallet of another chain cannot be tricked into making one. The digests themselves already carry a tag and the chain
// id (chain/core.js hashOf). The older form (the Ethereum message prefix) is accepted only before rules v4.
// Works in Node and in the browser (public/sig.js is this same file).
(function (root) {
  const E = typeof module !== "undefined" && module.exports ? require("ethers").ethers || require("ethers") : root.ethers;
  const PREFIX = "\x19AGT Signed Message:\n32";
  const MARK = "agt:";
  const agtHash = (digest) => E.keccak256(E.concat([E.toUtf8Bytes(PREFIX), E.getBytes(digest)]));
  // sign with an ethers Wallet (or anything holding a signingKey)
  const sign = (wallet, digest) => MARK + wallet.signingKey.sign(agtHash(digest)).serialized;
  const isAgt = (sig) => typeof sig === "string" && sig.startsWith(MARK);
  // the signer's address (lowercase hex). allowOld: accept the older Ethereum-prefixed form (before rules v4 only)
  function recover(digest, sig, allowOld) {
    if (isAgt(sig)) return E.recoverAddress(agtHash(digest), sig.slice(MARK.length)).toLowerCase();
    if (!allowOld) throw new Error("signature must be AGT's own form (agt:…) from rules v4");
    return E.verifyMessage(E.getBytes(digest), sig).toLowerCase();
  }
  const api = { sign, recover, isAgt, agtHash, PREFIX, MARK };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AGTSig = api;
})(typeof self !== "undefined" ? self : this);
