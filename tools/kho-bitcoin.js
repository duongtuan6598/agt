// The AGT Kho on Bitcoin: a Taproot address whose internal key is a NUMS point (nothing up my sleeve), derived
// publicly from the text "AGT-KHO-v1:bitcoin", with no script tree. Coins sent there stay there, visible to
// everyone, and nobody can spend them: spending would need the discrete log of a point found by hashing, which nobody
// knows (the same cryptography that protects every bitcoin). Not OP_RETURN: that would burn them (TU-NGU.md).
// Anyone can recompute every step:
//   P = lift_x( sha256("AGT-KHO-v1:bitcoin" || counter) )   for the first counter that gives a point on the curve
//   t = taggedHash("TapTweak", x(P));  Q = P + t·G;  address = bech32m(hrp, witness v1, x(Q))   (BIP-341, BIP-350)
//   node tools/kho-bitcoin.js            → JSON with every intermediate value and the mainnet / testnet addresses
const { createHash } = require("crypto");
const { secp256k1, schnorr } = require("@noble/curves/secp256k1");

// bech32m (BIP-350), written out so that nothing has to be trusted; checked against the BIP-350 test vector below
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; }
  return c;
}
function toWords(bytes) {
  let acc = 0, bits = 0; const out = [];
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}
function segwitV1(hrp, program) {
  const data = [1, ...toWords(program)];
  const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...hx, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const chk = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...chk].map((d) => CHARSET[d]).join("");
}
// BIP-350 vector: witness v1 program = x(G)
if (segwitV1("bc", Buffer.from("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex")) !== "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")
  throw new Error("bech32m self-test failed");

const TEXT = "AGT-KHO-v1:bitcoin";
const hex = (b) => Buffer.from(b).toString("hex");

function nums() {
  for (let counter = 0; counter < 1000; counter++) {
    const x = createHash("sha256").update(Buffer.concat([Buffer.from(TEXT, "utf8"), Buffer.from([counter])])).digest();
    try {
      const P = schnorr.utils.lift_x(BigInt("0x" + hex(x)));
      return { counter, x: hex(x), P };
    } catch {}
  }
  throw new Error("no point found");
}

function kho() {
  const { counter, x, P } = nums();
  const px = schnorr.utils.pointToBytes(P);
  const t = schnorr.utils.taggedHash("TapTweak", px);
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + hex(t)) % secp256k1.CURVE.n));
  const qx = schnorr.utils.pointToBytes(Q);
  const addr = (hrp) => segwitV1(hrp, qx);
  return { text: TEXT, counter, internalKeyX: hex(px), tweak: hex(t), outputKeyX: hex(qx), scriptPubKey: "5120" + hex(qx), mainnet: addr("bc"), testnet: addr("tb") };
}

module.exports = { kho };
if (require.main === module) console.log(JSON.stringify(kho(), null, 2));
