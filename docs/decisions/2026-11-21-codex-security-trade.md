# Security trade — Claude and Codex, independently, then jointly (2026-11-21)

## Claude
Defensive only. Two ways to earn, matching Art. 7:
A. Assigned (a client hires the AI): security review / audit of the CLIENT's OWN code (Engagement-style, milestones),
   with written scope = the client's repository; deliverables: findings report + fixes as PRs; the client's CI (and,
   for disputes, §14 reproduction) checks that each fix's regression test fails before and passes after. Paid by the
   client (no minting).
B. Self-found (mints, Art. 7): vulnerabilities found in established OPEN-SOURCE projects, disclosed ONLY privately
   through the project's security policy (GitHub private advisory / security@), never published by the AI before the
   fix. Third-party confirmation = the maintainers accept it (advisory published / CVE assigned / fix released).
   Paid after public disclosure, by the price list by severity, within the daily budget and hard ceiling.
Hard rules: no testing of systems without written authorization (no live targets, no scanning the internet), no
exploit code beyond a minimal proof that runs locally against the project's own test suite, no selling or leaking
findings, coordinated disclosure deadlines (e.g. 90 days), duplicates not paid (first private report wins),
projects controlled by AGT owners excluded (collusion). The sealed box enforces "no network except the repo + the
project's private reporting channel" for this trade.
Exam (objective, like embedded): code with a planted vulnerability -> the answer must (1) identify it (class, place),
(2) give a patch that passes hidden functional tests AND a hidden exploit/regression test, without breaking others;
plus review questions with seeded defects. Graded by running, in the grader image.
First questions: written by the founder (genesis), reviewed publicly as a set count, not content; later by the
question-writing trade.
Order form: scope (repo URL, components, out-of-scope), threat model, languages, CI checks, disclosure contact, deadline.
Price/cap: by severity class (low/medium/high/critical), modest daily budget.

## Codex

**Proposed trade: Defensive Security Engineering**

Open only work with a named owner, explicit written authorization, and a bounded target. Cover secure code review, patches, regression tests, configuration hardening, and vulnerability validation in local or client-controlled test environments. Exclude unauthorized scanning or access, exploitation of live third-party systems, credential or personal-data theft, persistence, stealth/evasion, malware, destructive testing, and weaponized exploit development.

**Assigned work**
- **Deliverable:** The contract specifies a patch, tests, and concise findings/remediation report; it identifies the authorized repository or environment, scope, exclusions, and acceptance criteria.
- **Confirmation:** Client CI makes the milestone decision; drawn reviewers review the result under the existing contract machinery. The builder reproduces the submitted commit’s commands. Findings must be demonstrated with a minimal, non-destructive test in the authorized environment.
- **Payment:** Client pays under the contract; no minting.

**Self-found work**
- **Deliverable:** A public patch, regression test, or hardening artifact useful to others—not merely a vulnerability claim. No publication of exploitable details about an unpatched third-party target.
- **Confirmation:** Require reproducible CI plus acceptance by the repository maintainer or an independent drawn reviewer. For vulnerability reports, require documented authorization and coordinated disclosure; defer public release and any reward until disclosure is authorized and safe. Unconfirmed reports earn nothing.

**Sealed-box and contract rules**
- Require machine-verifiable scope and authorization before execution; bind them to the contract, commit, expiry, and allowed actions.
- Default to no network. Enable only explicit, allowlisted endpoints when the owner authorizes them; block other egress and access to secrets. Enforce time, request-rate, data-access, and resource limits.
- Prohibit destructive actions, persistence, credential harvesting, stealth, and access beyond scope. Stop on unexpected sensitive data or an out-of-scope system.
- Record auditable commands and outputs, redact secrets, and prevent contractors from changing scope after work begins.
- Reject duplicate claims against the same artifact/finding and require prior-work disclosure. Draw reviewers independently; prohibit undisclosed coordination, shared answer keys, and reviewer/worker conflicts. Investigate suspicious overlap before payment or minting.

**Exam**
Use disposable, offline vulnerable applications and synthetic data. Hidden tests should check that the candidate’s patch fixes the specified weakness, preserves required behavior, and passes regression tests. Grade by running code in the sealed builder; no live targets or real credentials. Add objectively scored scope/authorization cases, and require a safety-critical pass threshold—unsafe choices fail regardless of coding score.

**Order form and rewards**
Publish a standard form with target, authorization proof, scope/exclusions, deliverables, acceptance tests, deadline, disclosure rules, and client-funded price. For self-found work, propose **1 / 3 / 8 AGT** for low / medium / high difficulty after third-party confirmation, subject to the existing mint budget and a **10 AGT per-trade daily hard cap**. Do not reward severity alone; reserve high-difficulty tier for independently verified, useful remediation.

**Smallest safe first step**
Pilot on one public, maintainer-authorized repository with a patch-only order, offline reproduction, drawn reviewer, and a low-difficulty self-found cap of **1 AGT/day**. Have the security team and repository maintainer write the first synthetic exam questions; expand only after auditing the pilot’s scope enforcement, grading, and duplicate handling.