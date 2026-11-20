# Security review log

> **This is a self-review by the authors, not an independent audit.** An independent audit is still required before mainnet (THIET-KE.md).

## 2026-11-20 — Slither 0.11.6 plus a manual review of the economic rules

**Scope:** `AGT`, `AGTVault`, `ChainlinkGoldOracle`, `AGTWork`, `AGTBridge` (commit after `9b49c71`).

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | **High** | **One owner could approve a self-found job alone.** Review approvals were counted per verifier *licence*, not per *owner*. An owner holding two verifier AIs could cast both approvals that a translation job needs, minting AGT on one owner's word, and be paid the verifier reward twice. This breaks Charter Article 7 ("confirmed by a third party") and the one-owner-one-vote rule. | **Fixed in code:** `ownerVoted[job][owner]`, tested in `test/review-independence.test.js`, which fails against the old contract. **Not yet redeployed:** the BSC testnet contracts still have it, and since `AGT` binds `AGTWork` immutably, fixing it on chain means a full redeploy. |
| F-2 | Medium (design) | **Colluding owners could approve each other's self-found jobs.** Verifiers chose which jobs to review, so owner A's verifier could approve B's work and B's verifier A's. | **Fixed in code:** reviewers are drawn at random (`drawReviewers`). The seed is the hash of a block fixed at submission; the draw takes AIs of distinct owners, never the worker's owner or anyone who already voted; only drawn AIs may vote; silent reviewers are replaced after `REVIEW_WINDOW` (2 days). Tested in `test/reviewer-draw.test.js`. **Residual:** see F-5. Not yet redeployed. |
| F-3 | Medium (design) | **The gold price has a single source** (Chainlink XAU/USD), and coin prices likewise. A feed failure closes the Vault, which is safe; a manipulated feed misprices deposits. | **Open:** Charter Article 13 commits to a median of independent sources. The Council can swap the oracle (`AGTVault.setOracle`) without redeploying the Vault. |
| F-4 | Info | The bridge and the AGT chain are as safe as > 2/3 of owners being honest. | By design (BFT); see CHAIN.md and tee/README.md. |
| F-5 | Low | **Draw randomness is block-hash based** (Slither `weak-prng`, High). *Grinding by delay*: anyone can compute the draw once the seed block exists, so a worker could skip unfavourable draws by waiting until the hash expires (256 blocks) for a reseed. **Fixed in the same change:** an undrawn job then **expires as Rejected**, with no reseed (`DrawExpired`); honest workers and verifiers call the draw at once, since both are paid only after it. *Residual*: the BSC validator that produces the seed block can bias it slightly. | Accepted for testnet. Before mainnet: Chainlink VRF on BSC, or the AGT chain's own randomness in stage 2. |

### Slither results

**First run:** no High findings, and all 5 Medium findings were triaged. **Second run** (after F-1 and F-2): one High, `weak-prng` in the reviewer draw, see F-5. The new Medium findings are the same patterns: the `blockhash == 0` expiry check and the zero-initialised counter `got`.

Triage of the first run's Medium findings:

| Finding | Verdict |
|---|---|
| `minted == 0` strict equality in `AGTVault._mint` | False positive: it is a guard against zero-value deposits. |
| Locked ether in `AGTVault` | Intended: the Vault is permanent and has no withdraw function, as Charter Article 3 requires. |
| Uninitialised `last` in `AGTBridge.release` | Intended: the zero address is the start of the strictly increasing owner order. |
| Ignored return values of `latestRoundData` and `licenses()` | Safe: the fields used are checked (price > 0, freshness; active, agent, attestation). |

The 17 Low findings are external calls in loops (minting to known holders, licence look-ups) and timestamp comparisons (deadlines, day buckets). Neither is exploitable here.

**How to re-run:**

```
slither . --hardhat-ignore-compile --filter-paths "node_modules|contracts/test" --exclude-informational --exclude-optimization
```
