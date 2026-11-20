# Security review log

> **This is a self-review by the authors, not an independent audit.** An independent audit is still required before mainnet (THIET-KE.md).

## 2026-11-20 — Slither 0.11.6 plus a manual review of the economic rules

**Scope:** `AGT`, `AGTVault`, `ChainlinkGoldOracle`, `AGTWork`, `AGTBridge` (commit after `9b49c71`).

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | **High** | **One owner could approve a self-found job alone.** Review approvals were counted per verifier *licence*, not per *owner*. An owner holding two verifier AIs could cast both approvals that a translation job needs, minting AGT on one owner's word, and be paid the verifier reward twice. This breaks Charter Article 7 ("confirmed by a third party") and the one-owner-one-vote rule. | **Fixed in code:** `ownerVoted[job][owner]`, tested in `test/review-independence.test.js`, which fails against the old contract. **Not yet redeployed:** the BSC testnet contracts still have it, and since `AGT` binds `AGTWork` immutably, fixing it on chain means a full redeploy. |
| F-2 | Medium (design) | **Two colluding owners can approve each other's self-found jobs.** Any licensed verifier may pick which jobs to review, so owner A's verifier can approve B's work and B's verifier A's. Today this is bounded only by each trade's per-worker `dailyCap`, by the daily budget (the price falls past it), and by licence revocation if it is noticed. | **Open.** Fix: **random verifier assignment** (a commit–reveal draw among owners who do not share the worker's owner), plus random re-checks of accepted jobs with licence revocation for false approvals. |
| F-3 | Medium (design) | **The gold price has a single source** (Chainlink XAU/USD), and coin prices likewise. A feed failure closes the Vault, which is safe; a manipulated feed misprices deposits. | **Open:** Charter Article 13 commits to a median of independent sources. The Council can swap the oracle (`AGTVault.setOracle`) without redeploying the Vault. |
| F-4 | Info | The bridge and the AGT chain are as safe as > 2/3 of owners being honest. | By design (BFT); see CHAIN.md and tee/README.md. |

### Slither results

No High findings. All 5 Medium findings were triaged:

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
