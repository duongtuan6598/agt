// Fresh verification collateral straight from the chip vendors (Charter Article 13: no middleman):
//   Intel PCS — TDX TCB info, TD quoting-enclave identity, PCK CRL (+ the TCB signing / CRL issuer chains)
//   AMD KDS   — CRL per product
// Everything fetched here is SIGNED by the vendor and re-verified by tee/tdx.js / tee/snp.js; the network
// path is not trusted. Collateral expires (nextUpdate, ~1 month), so it is fetched when verifying.
const PCS = "https://api.trustedservices.intel.com";
const pemList = (s) => decodeURIComponent(s || "").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];

async function get(url, as = "text") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return { body: as === "bytes" ? Buffer.from(await r.arrayBuffer()) : await r.text(), headers: r.headers };
}

async function intel(fmspc) {
  const tcb = await get(`${PCS}/tdx/certification/v4/tcb?fmspc=${fmspc}`);
  const qe = await get(`${PCS}/tdx/certification/v4/qe/identity`);
  const crl = await get(`${PCS}/sgx/certification/v4/pckcrl?ca=platform&encoding=der`, "bytes");
  const root = await get("https://certificates.trustedservices.intel.com/IntelSGXRootCA.der", "bytes");
  return {
    tcbInfo: { json: tcb.body, chain: pemList(tcb.headers.get("TCB-Info-Issuer-Chain")) },
    qeIdentity: { json: qe.body, chain: pemList(qe.headers.get("SGX-Enclave-Identity-Issuer-Chain")) },
    crl: { platform: crl.body, root: root.body },
  };
}

async function amdCrl(product) {
  return (await get(`https://kdsintf.amd.com/vcek/v1/${product}/crl`, "bytes")).body;
}

// Collateral for one piece of evidence (or one escrow request).
async function forAttestation(att) {
  if (att.platform === "dstack-tdx") {
    const { parseQuote, pckTcb } = require("./tdx.js");
    return { intel: await intel(pckTcb(parseQuote(att.quote).pems[0]).fmspc) };
  }
  if (att.platform === "azure-snp") {
    const { productOf } = require("./snp.js");
    const pems = String(att.certChain).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const product = productOf(pems.slice(1).join("\n"));
    return { amdCrl: product ? await amdCrl(product) : null };
  }
  return {};
}

module.exports = { intel, amdCrl, forAttestation };
