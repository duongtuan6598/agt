# The exam grading trade — Claude and Codex, independently, then jointly (2026-11-21)

The founder asked to open the grading trade so that licences stop depending on the founder's machine.

## Claude
Goal: licences no longer depend on the founder's machine grading answers with the private bank.
1. Graders are sealed AI boxes running an approved GRADER image (separate approval list, like builders). The
   private bank never leaves sealed boxes: it is held escrowed among grader/exam boxes and released only to an
   attested grader for one exam, sealed to its one-job key; the grader sees hidden tests, never publishes them.
2. Per exam, 3 graders are DRAWN (blockhash seed) from licensed graders of 3 different owners, none of the
   candidate's owner. Each grades independently and signs a canonical result (per question pass/fail + digest of
   its observations). For objective trades (embedded) results must match exactly; 2-of-3 identical -> recorded on
   chain; a mismatch -> the dissenting grader's result goes to drawn verifiers, and a grader whose result is wrong
   loses reputation / licence. The licence is then granted by the contract from the agreed result (no founder step
   after genesis).
3. Graders run candidates' code: same isolation duty as §14 builders — fail closed if the sandbox can reach a TEE
   socket (T-1), no network, fresh container per answer, bank via stdin only (G-1).
4. Exam for graders (Art. 5): grade a calibration set with KNOWN outcomes, including hostile answers (sandbox
   escapes, bank-reading attempts, nondeterminism, timeouts); must match the known results exactly.
5. Pay: per graded exam from the public price list (Art. 7 work, confirmed by the other graders' agreement);
   whoever wants a licence does not pay a fee (Art. 8); daily caps.
First step: design doc + contract interface; then a grader image reusing grade-cli.js; then a local 3-grader
rehearsal. Open questions: where the bank lives during genesis exit; bank updates; subjective trades (translation)
where results cannot match exactly (use the 101 verifier rubric and a tolerance).

## Codex

## 1. Grading trade

**Separate grading from licensing.** A protocol contract grants a licence only after it verifies a quorum of valid, eligible grader attestations. The founder’s machine may remain an implementation of a grader, but it has no special authority.

- **Select graders by lottery:** For each exam, draw a fixed number of independently owned, licensed grader AIs from a committed eligible pool, excluding the candidate’s owner and question authors. Enforce one owner, one vote; require a quorum across distinct owners. Use public randomness after the candidate and exam commitments are fixed.
- **Keep the bank private:** Store versioned, encrypted question and test packages in replicated, content-addressed storage. Authors commit to a package before selection and cannot grade their own questions. Threshold key shares are held by independent custodians; release only the selected package’s decryption key to a measured, approved grader workload—not to an owner or candidate.
- **Record evidence:** Each grader signs the exam/package hashes, candidate submission hash, grader-image hash, verdict, and a minimal result summary. Publish commitments and signatures on chain; keep questions, tests, and sensitive traces encrypted and access-controlled. The contract verifies eligibility, quorum, and matching verdicts before licensing.
- **Handle disagreement or misconduct:** Disagreement triggers a new draw of reviewers under Article 7, excluding the worker’s owner and preserving one-owner-one-vote. Reviewers inspect reproducible evidence where safe, or rerun in an independently approved environment. Invalid attestations, conflicting evidence, or proven misconduct invalidate the affected verdict and may trigger slashing or suspension only if those remedies are authorized by the charter/contracts. Preserve an appeal path and auditable records.

For genesis, define an explicit bootstrap protocol in advance: the first verifier candidates are graded by independent, reproducible harnesses and a temporary multi-owner quorum, not by the founder. Retire that bootstrap authority once three verifier AIs of three owners exist. Grader AIs must themselves pass an exam; the protocol’s deterministic verification machinery is not a discretionary grading authority.

## 2. Objective vs. subjective trades

Use **two grading paths** under one licence-and-audit protocol. Objective trades run hidden tests and report reproducible pass/fail evidence. Subjective trades, such as translation quality, use a blinded rubric and multiple independently drawn reviewers; record scores, rubric version, and disagreement. Don’t pretend a subjective judgment is a deterministic test result.

## 3. Graders’ own exam

Test correctness, reproducibility, isolation, key-handling, and refusal behavior using public fixtures plus private, rotating challenge cases. Require independent graders to agree on known-good and adversarial submissions. Re-exam on material grader-image or policy changes; revoke eligibility when evidence shows a grader leaked data or misreported results.

## 4. Biggest risks and mitigations

- **Bank leakage:** threshold-held keys, per-exam release, rotation, access logs, canary cases, and limited exposure. A compromised grader may still leak what it sees.
- **Collusion:** owner-diverse draws, post-commit randomness, conflict exclusions, audits, and re-grading. Owner diversity reduces—not eliminates—coordination risk.
- **Candidate escape or test extraction:** don’t put secrets in a sandbox the candidate can reach. The known attestation-socket exposure is a hard stop: if candidate code can reach it, do not release secrets or run that workload. Require a separately verified isolation boundary, no candidate access to keys, broker, or network, and bounded outputs/resources; otherwise use public tests or defer the trade.
- **Cost:** cache verified grader images, run a small quorum first, and reserve extra draws for disagreement or audits. Don’t cut the minimum owner diversity.

## 5. Smallest useful first step

Pilot one **objective, low-stakes trade** with a tiny private bank, two independently owned attested graders plus a drawn reviewer for disagreement, and no automatic licence until the evidence and isolation path are validated. Keep secrets out of any candidate-reachable attestation socket.