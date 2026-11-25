// Test vectors from the JavaScript rules, for the Rust ones to match byte for byte: node chain-rs/make-vectors.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const C = require("../chain/core.js");
const A = require("../chain/address.js");
const S = require("../chain/sig.js");
const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));
const ser = (s) => JSON.stringify(s, (k, v) => (typeof v === "bigint" ? { $n: v.toString() } : v));
const values = [
  { b: 2n ** 200n, a: [1, 2.5, -0, 1e21, 1e-7, 123456789012345680000], s: "é \"\\n\u0001/", z: null, t: true },
  { "Z": 1, "a": 2, "é": 3, "ä": 4, "10": 5, "9": 6, "😀": 7, "￿": 8 },
  [], {}, "", 0, { nested: { $n: "5" } },
];
const canon = values.map((v) => { const j = ser(v); return { json: j, canon: C.canon(des(j)), hash: C.hashOf(des(j)) }; });
const wallets = [1, 2, 3].map((i) => new ethers.Wallet(ethers.id("vec-" + i)));
const addrs = wallets.map((w) => ({ hex: w.address.toLowerCase(), agt: A.toAgt(w.address) }));
const sigs = [];
for (const w of wallets) for (const d of [ethers.id("a"), ethers.id("b")]) {
  sigs.push({ digest: d, sig: S.sign(w, d), who: w.address.toLowerCase(), old: false });
  sigs.push({ digest: d, sig: w.signingKey.sign(ethers.hashMessage(ethers.getBytes(d))).serialized, who: w.address.toLowerCase(), old: true });
}
fs.writeFileSync(path.join(__dirname, "tests", "vectors.json"), JSON.stringify({ canon, addrs, sigs }, null, 1));
console.log(`${canon.length} canon, ${addrs.length} addresses, ${sigs.length} signatures`);
