// AGT's own address format: "agt1" + bech32m of the 20-byte account (BIP-350 checksum, hrp "agt"). The same key and
// the same account as before, only written AGT's way: an error in any character is caught by the checksum, and an
// address of another chain can never be mistaken for an AGT one. Internally the ledger keeps the 20 bytes as hex.
// Works in Node and in the browser (public/agt1.js loads this same file).
(function (root) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const M = 0x2bc830a3; // bech32m constant
  const HRP = "agt";
  function polymod(v) {
    let c = 1;
    for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i]; }
    return c >>> 0;
  }
  const hrpx = (h) => [...[...h].map((ch) => ch.charCodeAt(0) >> 5), 0, ...[...h].map((ch) => ch.charCodeAt(0) & 31)];
  function convert(data, from, to, pad) {
    let acc = 0, bits = 0; const out = [], maxv = (1 << to) - 1;
    for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
    if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error("bad AGT address padding");
    return out;
  }
  const hexToBytes = (h) => { const s = h.replace(/^0x/i, ""); if (!/^[0-9a-fA-F]{40}$/.test(s)) throw new Error("not a 20-byte account"); return s.match(/../g).map((b) => parseInt(b, 16)); };
  function toAgt(hex) {
    const words = convert(hexToBytes(hex), 8, 5, true);
    const mod = polymod([...hrpx(HRP), ...words, 0, 0, 0, 0, 0, 0]) ^ M;
    const sum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
    return HRP + "1" + [...words, ...sum].map((w) => CHARSET[w]).join("");
  }
  function fromAgt(addr) {
    const a = String(addr);
    if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error("mixed case AGT address");
    const s = a.toLowerCase();
    if (!s.startsWith(HRP + "1")) throw new Error("not an AGT address (agt1…)");
    const data = [...s.slice(HRP.length + 1)].map((ch) => { const i = CHARSET.indexOf(ch); if (i < 0) throw new Error("bad character in AGT address"); return i; });
    if (data.length < 6 || polymod([...hrpx(HRP), ...data]) !== M) throw new Error("AGT address checksum is wrong (a typo?)");
    const bytes = convert(data.slice(0, -6), 5, 8, false);
    if (bytes.length !== 20) throw new Error("AGT address has the wrong length");
    return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const isAgt = (a) => typeof a === "string" && /^agt1/i.test(a);
  // any form → the ledger's internal form (lowercase hex); throws on anything else
  const toHex = (a) => (isAgt(a) ? fromAgt(a) : "0x" + hexToBytes(String(a)).map((b) => b.toString(16).padStart(2, "0")).join(""));
  const api = { toAgt, fromAgt, toHex, isAgt, HRP };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AGTAddress = api;
})(typeof self !== "undefined" ? self : this);
