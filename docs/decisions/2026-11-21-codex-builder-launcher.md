# Codex's independent design for the builder launcher (verbatim), 2026-11-21

Asked once; Claude reconciled; the joint decision is THIET-KE-NGHE-NHUNG.md §15.

**Recommendation**

1. **Use (b) and (c) together.** Keep the VM in a VPC with default-deny egress; allow only the exam service’s private relay. Run the disputed build commands inside a QEMU guest with **no NIC**. The VM’s trusted supervisor fetches the job and sealed source, stages them for the guest, then submits the result. This keeps build code from making network requests while preserving narrowly scoped host networking. The guest boundary is defense in depth: a QEMU escape reaches the disposable VM, not the cloud project. Document that the host supervisor still has relay access. If QEMU is out of scope for the first implementation, (c) alone is a pragmatic fallback—not equivalent isolation.

2. **Use a separate builder image** and a separate `policy.builderImages` approval list. A distinct digest makes the builder’s trust decision explicit and avoids treating a general AI-box image as a build executor. Don’t make `AGT_MODE=builder` the security boundary: mode is configuration, not identity. If it is retained for routing, require the expected mode in attested claims as well as the approved builder digest.

**`verifyBuilder` contract**

Verify the platform evidence first, then the result signature and bindings. Fail closed on missing, malformed, duplicate, or unexpected claims.

- Require a canonical, versioned full manifest encoding with a documented hash (for example, SHA-256 over canonical JSON). Include every security-relevant field: dispute/job ID, commit, exact commands, image digest, job public keys, and a cryptographically random per-job nonce. Put the manifest hash in Google’s `eat_nonce`; compare it to the verifier’s independently expected manifest hash. Require the evidence’s nonce, image, and all job inputs to match—never trust fields supplied only by the result.
- On Google Confidential Space, validate the JWT signature against trusted Google issuer keys; enforce issuer, audience, `exp`, `nbf`/`iat` and reasonable clock skew. Require production `dbgstat`, expected `swname`, allowed `hwmodel` (SEV/TDX), Secure Boot, approved `container.image_digest`, and exact `container.env`/override values for the job and mode. Reject debug images and unexpected args or restart settings. Google documents these token claims, including image digest, environment, hardware model and `eat_nonce`; metadata-provided env is operator-controlled, so accept it only as evidence-bound input matched against the expected manifest—not as authorization by itself. [Google token claims](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims) [Google security overview](https://docs.cloud.google.com/docs/security/confidential-space)
- For dstack/TDX and Azure, implement separate evidence adapters; do not assume Google claim names or semantics. Validate the attestation chain, hardware/TCB policy, debug status, and the platform’s cryptographic binding of the expected manifest hash (nonce/report data or enforced policy hash). Azure’s documented ACI claims include compliance status, debug state, and CCE policy hash; require the expected policy hash and supported hardware/TCB. [Azure attestation claims](https://learn.microsoft.com/en-us/azure/container-instances/confidential-containers-attestation-concepts)
- Finally verify the result’s secp256k1 signature using the manifest-bound signing key; bind the result to the manifest hash, nonce, commit and job ID. Enforce one-time job completion in the exam service so valid evidence cannot be replayed. A fresh token alone does not make a reused job fresh.

**Launch and lifecycle**

The party seeking evidence runs a reviewed launcher script under **their own cloud account**. It creates one VM per job from the approved builder image, with pinned image digest, confidential-computing flags, no inbound access, restrictive egress, and a minimal service account with no project roles. The VM authenticates to the exam service using a short-lived, job-scoped credential—not cloud IAM privileges. Supervisor obtains the job, requests attestation bound to the manifest, runs the job, posts evidence/result, then shuts down. Configure provider-side maximum lifetime/auto-delete and budget alerts; self-shutdown is not enough if the VM hangs or the operator disappears. The VM owner pays and remains responsible for deletion and residual resources.

**Implement and test now**

Build `verifyBuilder` around evidence-adapter interfaces and fixtures: valid/invalid Google tokens, claim mismatches, expiry/replay, canonicalization vectors, signature mismatch, and unapproved digests. Add a fake launcher/exam-service flow to test manifest creation, nonce binding, result verification and cleanup behavior without cloud resources. Keep live launch disabled by default.

Before a real run, require the human to approve the cloud/account/project, region and VM type, estimated cost and maximum lifetime, approved image digest and policy, network/relay rules, and the job’s commit and exact commands.