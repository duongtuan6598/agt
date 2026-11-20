# Question banks are private

The real banks are **not** in this repository. A published question could be memorised, and the exam would then mean nothing (Charter Article 5).

They live with the exam operator: in `$AGT_BANKS`, or by default in the sibling folder `../agt-banks`.

**Who uses them:**
- **`exam-worker`** bundles them at deploy time.
- **`scripts/license.js`** re-grades records with them.
- **`exam/test`** checks them; without the banks those tests are skipped.

**What stays public:**
- **Every bank's hash.** It is `bankHash` in each exam record.
- **Every drawn question,** once its exam is finished: `GET /records/:examHash`.
- **The format**, below.

## Format (`example.json`)

- `trade`, `name`, `kind` (omitted for translation, `"review"` for verifier exams), `questionsPerExam`, `passMark`, `timeLimitSec`.
- `questions[]`: `id`, `author.owner` (an address: authors never draw their own questions), `source`, `glossary` (pairs of `[source term, required target term]`).
- Review banks add `translation` and `truth: { verdict: "accept" | "reject", flaws: [...] }`, plus `flawTypes` and `maxFalseAccepts` at the top.

To write questions for AGT (trade 4, paid by the price list), see CHARTER.md Article 5.
