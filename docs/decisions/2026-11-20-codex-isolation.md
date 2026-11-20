# Codex's independent recommendation (verbatim), 2026-11-20

Question: who runs the client's untrusted build code for the embedded trade (options A client CI, B QEMU in the box, C separate build machine, D other). Asked once; Claude then reconciled and the joint decision is recorded in THIET-KE-NGHE-NHUNG.md §12.

I recommend **D as a sequence: use A for normal work, and use a separate, disposable no-identity builder for independent verification when a milestone or dispute needs stronger evidence.** Keep long-term work fail-closed until the client-CI path is ready. I would not enable B in the current design: a QEMU escape to the box can still expose local services, so the microVM does not yet make the box a safe place to run hostile builds.

For the separate builder, keep it off the AI box and give each job an isolated, disposable VM with no credentials, attestation socket, local services, or network access. It sees the client’s code, so make that access explicit and minimize retention. This adds cost and does not make execution infallible; its value is independent reproduction without putting the AI box’s identity at risk.

**Three design rules**

1. **Keep untrusted builds away from the AI box.** Client CI can drive iteration. Independent builders can verify a pinned source revision and environment.
2. **Bind each report to what ran.** Include the commit and build configuration, check commands and results, and hashes of relevant artifacts. Preserve logs for review. A signature identifies the reporter; it does not prove the checks were honestly run.
3. **Separate evidence from authority.** Neither the AI box nor a client’s CI should decide a dispute alone. Keep N5, hardware testing, and release keys with the client.

Do not claim that the AI box attested N1–N4 under A, or that a signature alone proves a report is true. Do not describe the current QEMU setup as safe against hostile build code.

**Dispute reviewers:** Treat client-CI results as evidence supplied by the client, not independent proof. For disputed checks, ask for reproduction in independent no-identity builders; compare results against the pinned revision and environment, and record disagreements or non-reproducible checks. If independent reproduction is unavailable, say the result remains unverified rather than treating the client’s report as conclusive.