// Production check of a reproduction builder (THIET-KE-NGHE-NHUNG.md §14–§15, joint decisions of Claude and Codex).
// A builder is trusted ONLY if its attestation evidence proves, for the CANONICAL FULL manifest:
//   - a genuine TEE (Confidential Space token signed by Google — issuer, audience, hardware, no debug, secure boot,
//     STABLE image — or a dstack TDX quote / Azure SEV-SNP report with collateral, via tee/verify.js),
//   - an image on the separate builder approval list (policy.builderImages — NOT the AI box list),
//   - the attestation nonce = hash of exactly this manifest (keys, nonce, dispute, commit, commands, image),
//   - the manifest's declared imageDigest = the attested image.
// Freshness: the manifest's random nonce is single-use (the exam service accepts one job per nonce and one result
// per job), so token expiry is not required for a result checked days later.
const T = require("../verify.js");

/// Returns verify(manifest, evidence) → boolean, for EngageLoop's verifyBuilder.
function makeVerifyBuilder({ jwks, policy = T.loadPolicy(), collateral = null, log = () => {} }) {
  const builderPolicy = { ...policy, imageDigests: policy.builderImages || [] }; // builder images only
  return (manifest, evidence) => {
    try {
      if (!manifest || manifest.agt !== "builder-v1" || !evidence) return false;
      if (!builderPolicy.imageDigests.length) return false; // nothing approved yet
      const att = evidence.platform ? evidence : { token: evidence.token };
      const c = T.verifyAttestation(att, { jwks, policy: builderPolicy, collateral, checkExpiry: false });
      if (!T.tokenNonces(c).includes(T.nonceOf(manifest))) return false; // the full manifest, nothing else
      const attested = c.submods && c.submods.container && c.submods.container.image_digest;
      if (manifest.imageDigest !== attested) return false;
      return true;
    } catch (e) {
      log(`builder evidence refused: ${e.message}`);
      return false;
    }
  };
}

module.exports = { makeVerifyBuilder };
