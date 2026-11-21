// Production check of a reproduction builder (THIET-KE-NGHE-NHUNG.md §14–§15, joint decisions of Claude and Codex).
// A builder is trusted ONLY if its attestation evidence proves, for the CANONICAL FULL manifest:
//   - a genuine TEE (Confidential Space token signed by Google — issuer, audience, hardware, no debug, secure boot,
//     STABLE image — or a dstack TDX quote / Azure SEV-SNP report with collateral, via tee/verify.js),
//   - an image on the separate builder approval list (policy.builderImages — NOT the AI box list),
//   - the attestation nonce = hash of exactly this manifest (keys, nonce, dispute, commit, commands, image),
//   - the manifest's declared imageDigest = the attested image.
// Freshness (Codex L-4): the manifest's random nonce is single-use (the exam service accepts one job per nonce and
// one result per job), and a result counts only with the signature of THAT job's key, which never leaves the
// builder's memory — so replaying old evidence gains nothing, and token expiry is not required for a result
// checked days later.
const T = require("../verify.js");
const EXPECTED_ARGS = ["node", "/agt/tee/builder/main.js"]; // the builder image's CMD (cmd override is disallowed)

/// Shared check for every disposable, single-job sealed worker (§14 builders, the exam graders): its attestation must
/// prove a genuine TEE, an image on ITS OWN approval list (`listKey`), the full manifest of kind `kind` in the nonce,
/// the attested image = the manifest's, restart policy Never, the image's own command, and no AGT_ override except
/// `allowEnv`. Returns verify(manifest, evidence) → boolean.
function makeVerifyJobBox({ jwks, policy = T.loadPolicy(), collateral = null, log = () => {}, listKey, kind, args, allowEnv = [] }) {
  const listPolicy = { ...policy, imageDigests: policy[listKey] || [] }; // this list only
  return (manifest, evidence) => {
    try {
      if (!manifest || manifest.agt !== kind || !evidence) return false;
      if (!listPolicy.imageDigests.length) return false; // nothing approved yet
      const att = evidence.platform ? evidence : { token: evidence.token };
      const c = T.verifyAttestation(att, { jwks, policy: listPolicy, collateral, checkExpiry: false });
      if (!T.tokenNonces(c).includes(T.nonceOf(manifest))) return false; // the full manifest, nothing else
      const ctr = (c.submods && c.submods.container) || {};
      if (manifest.imageDigest !== ctr.image_digest) return false;
      if (!evidence.platform) {
        // Confidential Space (Codex L-3, L-5): one run, one key — restart policy Never is REQUIRED; the command is the
        // image's own; only the listed operator overrides are allowed.
        if (ctr.restart_policy !== "Never") return false;
        if (ctr.args && JSON.stringify(ctr.args) !== JSON.stringify(args)) return false;
        const env = ctr.env || {};
        for (const k of Object.keys(env)) if (k.startsWith("AGT_") && !allowEnv.includes(k)) return false;
      }
      return true;
    } catch (e) {
      log(`${kind} evidence refused: ${e.message}`);
      return false;
    }
  };
}

/// Returns verify(manifest, evidence) → boolean, for EngageLoop's verifyBuilder.
function makeVerifyBuilder(o) {
  return makeVerifyJobBox({ ...o, listKey: "builderImages", kind: "builder-v1", args: EXPECTED_ARGS, allowEnv: ["AGT_BUCKET"] });
}

/// Exam graders (THIET-KE-NGHE-CHAM-THI.md): their own approval list, policy.graderImages.
function makeVerifyGrader(o) {
  return makeVerifyJobBox({ ...o, listKey: "graderImages", kind: "grader-v1", args: ["node", "/agt/tee/grader/main.js"], allowEnv: ["AGT_EXAM_URL"] });
}

module.exports = { makeVerifyBuilder, makeVerifyGrader, makeVerifyJobBox };
