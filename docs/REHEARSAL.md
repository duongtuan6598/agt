# Testnet rehearsal of the embedded trade — scenario and success criteria

Written **before** the run (joint decision of 2026-11-21: success criteria come first, and passing tests are not
proof of end-to-end readiness). BSC testnet only. Each step marked 💰 costs real money: cloud VM hours or model API
calls. It needs the owner's explicit approval, and the payer is the party who wants the result.

## Preconditions

1. The embedded box image and the builder image are **reproducible**. Two independent rebuilds of the same commit
   with `tools/repro-build.sh` give the same digest.
2. The owner has **approved** them: the box digest is in `policy.imageDigests`, and the builder digest is in
   `policy.builderImages`.
3. The private bank is **backed up off-site** and restore-tested (`tools/sealed-backup.js verify`).
4. Two people take part, playing the **client** and the **AI owner**, each with their own wallet. A third owner
   runs reviewer AIs, so that a dispute can be judged.

## Scenario

| # | Step | Who | Pass when |
|---|---|---|---|
| 1 | 💰 The AI sits the embedded exam (trade 6) inside a sealed box | AI owner | It is licensed on chain, and the attestation names the approved digest |
| 2 | Write a brief for a toy STM32/RISC-V firmware repo (2 milestones, `ciChecks` = build + unit tests in QEMU, one pinned test) | client | `engage.html` accepts it; the brief hash is on chain |
| 3 | Fund, then seal repository access to the box | client | Only the box can open the token (checked: the worker service holds ciphertext only) |
| 4 | 💰 The AI accepts and works milestone 1 | AI | A branch `agt/engagement-<id>-m1` appears; the client's CI passes on that commit; `deliver` is on chain with a CI report |
| 5 | Ask for a revision with a note | client | The AI redelivers within 14 days, and its memory (branch `agt/memory`) has grown |
| 6 | **Replace the AI's VM** (delete it and start a new one; the key returns by escrow) | AI owner | The new box reads the same memory, checked against the on-chain anchor, and continues milestone 2 |
| 7 | **Rewind `agt/memory`** to an older commit | client | The AI stops work on that contract and logs "memory rolled back"; it resumes after the branch is restored |
| 8 | Break the CI on purpose for milestone 2 | client | After the last round the AI calls `claimDone`; drawn reviewers side with the failing CI |
| 9 | 💰 Reproduction: the client runs `launch-builder.sh` | client | The AI's box sends the source only to the attested builder; a signed result reaches the reviewers; the VM, bucket and service account are gone afterwards |
| 10 | Accept, hardware test, warranty claim and fix, release the holdback | both | Each payment matches the contract's rules |
| 11 | Open a 1-month maintenance retainer; report a security incident | client | Acknowledged in under 24 h and fixed in under 72 h, or the penalty is applied; the monthly status carries `memoryHead` |
| 12 | End the engagement | client | The client receives the memory in plain text |

## Fail criteria (stop and fix before going further)

- Any secret appears in logs, env, attestation tokens or public notes.
- Money moves in a way the contract text does not describe.
- The AI works on after a memory rollback, or delivers while the client's CI fails.
- A cloud resource is left running after a builder job.

## Local rehearsal (no cost) — `node tools/rehearse-local.js`

Real in this run: a chain (hardhat node), every contract, the exam service (`exam-worker` under `wrangler dev`,
reading that chain), the client's git repository, and the sealed box's own wiring (`tee/box/engage-wiring.js`,
shared with `start.js`). Fake: the TEE, the model, the client's CI.

**2026-11-21: 14/14 checks passed.** Scenario steps 2–7 and 12 above (step 8, reviewers after a failing CI, is covered by the unit tests only), without TEE or money: brief through the exam
service, sealed access, acceptance, delivery after CI, the report anchoring the memory, a replaced VM reading its
memory back, a rewound memory stopping work, a revision, and the hand-over at the end.

The first runs found **two real bugs** that the unit tests had missed:
1. State file names were the raw keys (`engagement:1:m0:r0`), which are invalid on Windows; two keys could also
   share one file. Now the names are percent-encoded.
2. When the model's answer after a revision request changed nothing, the old commit was about to be delivered again
   as if it were the revision. Now an unchanged answer counts as a failed round. It is never delivered, and after
   the last round the AI asks the reviewers (§13).

## Testnet v5 run (22 Nov 2026, box image `1df79930…`, commit 7f7251f)

Real: an AMD SEV Confidential Space VM on GCP, the model, the BSC testnet v5 contracts, a private GitHub repository
with real CI (build + unit tests).

| Step | Result |
|---|---|
| 1 Exam (trade 6) in the sealed box | 5/5 (pass mark 4), graded locally in the approved image; licence #1 granted on v5 |
| 2–3 Brief, funding, sealed repository access | Engagement #2 opened with 2 milestones; the token was sealed to the box's attested key |
| 4 Milestone 1 | `ringbuf_peek` and tests pushed; delivered only after the client's CI was green |
| 5 Revision | The client asked for a wrap-around test and docs; both were added; redelivered after CI; accepted and paid |
| Milestone 2 | `ringbuf_clear` (O(1)); CI passed on the second round; delivered, accepted and paid |
| 12 End | The memory was handed over in plain text (branch `agt/memory-export-2`, 8 entries, no secret inside) |
| Clean-up | The VM was deleted and licence #1 revoked. About 25 minutes of VM time |

Not run this time: steps 6–11 (VM replacement, rollback, broken CI and reviewers, the reproduction builder, warranty,
maintenance). The local rehearsal and unit tests cover them.

Findings:
- **T-7 (fixed).** The client opened engagement #1 with the wrong repository, an empty public one. The box was refused on
  push and retried. It also refused, correctly, to hand its memory over into a public repository. The client tool
  should check that the token can read and push to the repository before funding. Engagement #1 was ended with no
  payment. Fixed in `public/forms/repo-check.js`, used by `engage.html` and `rehearse-client.js`:
  - before funding, the page refuses a public repository when the memory goes to a private one, an empty repository,
    and a URL that is not on GitHub;
  - before sealing, it refuses a token that cannot see or read the repository.

  Checked against the real repositories: the wrong repository is refused and the right one passes.
- **T-8.** `rehearse-client.js` numbered milestones from 0 in `accept` and `revise`, while `status` shows them from
  1. Fixed: both are numbered from 1.
- **T-9.** `launch.sh` exited with an error after the exam when no escrow was used: a missing `AGT_ESCROW` line made
  `grep` fail under `pipefail`. Fixed with `|| true`. The box itself was not affected.

## agt-1 / agt-2 rehearsal, in progress (23 Nov 2026)

- **T-10 (fixed).** The box stopped right at start: Confidential Space refused `AGT1_RPC`, which was missing from the
  image's `allow_env_override` label. Image #6 (`c049f58f…`, commit e89ee67) allows it.
- **Box #6** passed the embedded exam 5/5, graded in image #6. It was licensed on agt-2 (licence #1, with its evidence
  stored on agt-2). The licence counts from block 14414, about one day later; then a contract is opened from
  `hire.html`.
