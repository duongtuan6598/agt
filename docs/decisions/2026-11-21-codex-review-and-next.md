# Review N-1..N-4 and what next — Claude and Codex, independently (2026-11-21)

The founder asked both AIs to act as if the founder had no powers left, only the spirit of AGT.

## Claude (before reading Codex)
Done since the last joint ranking: bank backup (off-site, restore-tested, key only on paper), reproducible images
identical across Windows and GitHub's Ubuntu (weekly public check), persistent memory §16, guides, rehearsal plan.
Next, in order:
1. Approval path for the three images WITHOUT the founder: write the rule into the Charter process — an image digest
   enters policy.json only when (a) the weekly public workflow has confirmed it on >= 2 different days and (b) one
   independent party has rebuilt it; record each confirmation publicly (a file of signed attestations of rebuilds).
2. Rehearsal step 1 needs money (a confidential VM + model API) and a second person: prepare everything so that the
   owner only has to approve the cost; meanwhile run the whole embedded flow end-to-end on a LOCAL fake chain with a
   real git server and the real box code (no TEE), to catch integration bugs before spending money.
3. Gold custody / reserve proof: write down honestly what exists today (the Vault contract) and what is missing, as
   the first item of a mainnet-readiness list.

## Codex

## PART A — Review

### N-1 [High] Plaintext memory is published without a privacy gate
**Where ·** `engage-agent.js:257–274`, `repo-memory.js:113–121`  
**Problem ·** Every ended engagement with a token is exported automatically as plaintext to a client repository. There is no visible consent, destination-visibility check, or redaction step.  
**Scenario ·** Memory contains personal, confidential, or accidentally retained secret data; the repository is public or shared more broadly than expected, and the export persists on a branch.  
**Fix ·** Require explicit hand-over approval, show the exact destination and contents, and redact sensitive data before pushing. Make the export’s visibility and retention consequences clear.

### N-2 [Medium] Reproduction reference can be changed with the build
**Where ·** `.github/workflows/reproduce.yml:26–49`, `tee/reference-digests.json`  
**Problem ·** The workflow checks out the commit containing both the source and its expected digest, then compares that commit’s digest to that same tree’s reference. A commit can change the source and the expected digest together, making a self-consistent result look like independent approval.  
**Scenario ·** A changed image and matching reference digest are committed; the workflow passes, and readers mistake that for validation against an independently approved artifact.  
**Fix ·** Anchor the expected commit and digests outside the commit being tested—for example, in a protected release or signed approval—and make the workflow verify that anchor.

### N-3 [Medium] Backup verification can miss lost refs and working-tree changes
**Where ·** `tools/sealed-backup.js:64–73`  
**Problem ·** `verify` compares `HEAD`, its tree, and the ordered commit list reachable from `--all`; it does not compare refs by name or inspect the working tree. A missing tag or branch can go undetected if the commits remain reachable elsewhere. The comment also claims a working-tree comparison that the code does not perform.  
**Scenario ·** A restore drops a tag or branch, yet `verify` reports success because the commits are still reachable from another ref.  
**Fix ·** Compare sorted ref names and object IDs (including tags) and either compare index/worktree state or narrow the verification claim to committed refs and history.

### N-4 [Low] Archive failure is masked by the pipeline
**Where ·** `tools/repro-build.sh:13`  
**Problem ·** POSIX `sh` with `set -e` does not fail the pipeline when `git archive` fails but the final `docker buildx` command succeeds. The script may then print a digest for an incomplete context as though it built the requested commit.  
**Scenario ·** An archive error occurs after partial output; BuildKit accepts that input and emits an image.  
**Fix ·** Enable pipeline failure handling in a compatible shell or write/check the archive separately before passing it to BuildKit.

The crypto construction is broadly sound as shown: the format authenticates its header with AES-GCM and derives a key with scrypt. The larger backup risks here are completeness and verification claims, not an obvious cipher misuse.

## PART B — What should come next

1. **Run a controlled real-cloud rehearsal of the embedded trade.** First step: define a tiny, capped test with explicit abort conditions and no mainnet exposure; record what the cloud run proves and what it does not.
2. **Establish a real independent second owner.** First step: identify a candidate and agree on the authority, access, and recovery responsibilities they would actually hold.
3. **Gate mainnet on independent assurance and public answers.** First step: publish the audit scope and the unanswered gold-custody/reserve questions; do not treat reproducible images as approval for `tee/policy.json` or as a substitute for either.
## Joint decision

All four findings were checked and fixed (AUDIT.md N-1..N-4).

**Next, in order:**
1. **The image approval rule.** Reproducibility is necessary evidence, not approval (Codex). An image enters
   `tee/policy.json` only through the Charter's process, and only with this evidence:
   - the public workflow has confirmed the digest on at least two different days;
   - one party other than the founder has rebuilt it and got the same digest.
2. **Rehearsal, local first.** Run the whole embedded flow on a local chain, with a real git server and the real
   box code but no TEE, to catch integration bugs at no cost. Then run Codex's capped real-cloud rehearsal with
   explicit abort conditions. That second step needs the owner's approval of the cost.
3. **A second independent owner.** Write the embedded-trade owner guide so a stranger could run an AI; finding the
   person is human work.
4. **Mainnet readiness, written honestly.** Publish the audit scope and the open gold-custody and reserve-proof
   questions. Nothing here counts as a substitute for them.
