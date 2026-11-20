// Minimal DER (ASN.1) reader — just enough to read certificate extensions (Intel SGX/TDX TCB, AMD VCEK TCB)
// and certificate revocation lists. No dependencies.
function node(buf, off = 0) {
  const tag = buf[off];
  let len = buf[off + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr = 2 + n;
  }
  const start = off + hdr, end = start + len;
  const n = { tag, off, start, end, raw: buf.subarray(off, end), value: buf.subarray(start, end) };
  if (tag & 0x20) { // constructed
    n.children = [];
    for (let p = start; p < end;) { const c = node(buf, p); n.children.push(c); p = c.end; }
  }
  return n;
}

function oid(value) {
  const parts = [Math.floor(value[0] / 40), value[0] % 40];
  let v = 0;
  for (let i = 1; i < value.length; i++) {
    v = v * 128 + (value[i] & 0x7f);
    if (!(value[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join(".");
}
const int = (value) => value.reduce((a, b) => a * 256n + BigInt(b), 0n);

// Certificate extensions as { oid: valueBytes } (extnValue OCTET STRING contents).
function extensions(certDer) {
  const tbs = node(certDer).children[0];
  const ext = tbs.children.find((c) => c.tag === 0xa3);
  const out = {};
  if (!ext) return out;
  for (const e of ext.children[0].children) {
    const id = oid(e.children[0].value);
    out[id] = e.children[e.children.length - 1].value;
  }
  return out;
}

// CRL: { tbs (signed bytes), sigAlg oid, signature bytes, revoked: [serial bigint], thisUpdate, nextUpdate }
function crl(der) {
  const top = node(der);
  const [tbs, alg, sigBits] = top.children;
  const kids = tbs.children;
  let i = kids[0].tag === 0x02 ? 1 : 0; // optional version
  i += 2; // signature algorithm, issuer
  const time = (n) => {
    const s = n.value.toString("ascii");
    if (n.tag === 0x17) return new Date(`${Number(s.slice(0, 2)) < 50 ? "20" : "19"}${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}Z`);
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`);
  };
  const thisUpdate = time(kids[i++]);
  let nextUpdate = null;
  if (kids[i] && (kids[i].tag === 0x17 || kids[i].tag === 0x18)) nextUpdate = time(kids[i++]);
  const revoked = [];
  if (kids[i] && kids[i].tag === 0x30) for (const r of kids[i].children) revoked.push(int(r.children[0].value));
  return { tbs: tbs.raw, sigAlg: oid(alg.children[0].value), signature: sigBits.value.subarray(1), revoked, thisUpdate, nextUpdate };
}

module.exports = { node, oid, int, extensions, crl };
