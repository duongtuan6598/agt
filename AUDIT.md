# Security review log

> **This is a self-review by the authors, not an independent audit.** An independent audit is still required before mainnet (THIET-KE.md).

## 2026-11-20 — Slither 0.11.6 plus a manual review of the economic rules

**Scope:** `AGT`, `AGTVault`, `ChainlinkGoldOracle`, `AGTWork`, `AGTBridge` (commit after `9b49c71`).

### Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | **High** | **One owner could approve a self-found job alone.** Review approvals were counted per verifier *licence*, not per *owner*. An owner holding two verifier AIs could cast both approvals that a translation job needs, minting AGT on one owner's word, and be paid the verifier reward twice. This breaks Charter Article 7 ("confirmed by a third party") and the one-owner-one-vote rule. | **Fixed in code:** `ownerVoted[job][owner]`, tested in `test/review-independence.test.js`, which fails against the old contract. **Redeployed** to BSC testnet on 2026-11-20 as the v3 contracts: `AGTWork` `0xAF5012ff6221e214D4a721b2273212ea46185B03`. |
| F-2 | Medium (design) | **Colluding owners could approve each other's self-found jobs.** Verifiers chose which jobs to review, so owner A's verifier could approve B's work and B's verifier A's. | **Fixed in code:** reviewers are drawn at random (`drawReviewers`). The seed is the hash of a block fixed at submission; the draw takes AIs of distinct owners, never the worker's owner or anyone who already voted; only drawn AIs may vote; silent reviewers are replaced after `REVIEW_WINDOW` (2 days). Tested in `test/reviewer-draw.test.js`. **Residual:** see F-5. **Redeployed** to BSC testnet on 2026-11-20 (v3). |
| F-3 | Medium (design) | **The gold price has a single source** (Chainlink XAU/USD), and coin prices likewise. A manipulated feed would misprice deposits. | **Fixed in code:** `MedianGoldOracle` takes the median of several sources per asset, needs at least 2 fresh ones, refuses when they disagree by more than 2%, and has `freeze()` (8 tests). Its second source is **`AICouncilPriceFeed`: the licensed AIs themselves.** Each sealed-box AI reads several public markets (PAXG/XAUT and BNB on Coinbase, Kraken, Binance, OKX and Bitfinex, with no API keys) and signs the median rounded to a step. A price is recorded only with signatures from sealed AIs of > 2/3 of council owners, and the feed is closed until genesis ends (6 tests). Pyth stays a third source whenever someone pushes it (its Hermes API now needs a key). **Testnet:** the feeds are deployed (XAU `0x3E2bC5aE…D96B`, BNB `0xe75754c3…8263`) and wired into `MedianGoldOracle` `0x924CCEaA…aB8D`. **The Vault switches over once licensed AIs exist** (after genesis); until then it stays on Chainlink. |
| F-4 | Info | The bridge and the AGT chain are as safe as > 2/3 of owners being honest. | By design (BFT); see CHAIN.md and tee/README.md. |
| F-5 | Low | **Draw randomness is block-hash based** (Slither `weak-prng`, High). *Grinding by delay*: anyone can compute the draw once the seed block exists, so a worker could skip unfavourable draws by waiting until the hash expires (256 blocks) for a reseed. **Fixed in the same change:** an undrawn job then **expires as Rejected**, with no reseed (`DrawExpired`); honest workers and verifiers call the draw at once, since both are paid only after it. *Residual*: the BSC validator that produces the seed block can bias it slightly. | Accepted for testnet. Before mainnet: Chainlink VRF on BSC, or the AGT chain's own randomness in stage 2. |
| F-6 | Medium | **Owners without a sealed box could vote in the AI Council.** `propose` and `councilVote` accepted any active licence, and the > 2/3 threshold counted every licensed owner. Charter Article 12 says Council AIs must run in a sealed box. | **Fixed and redeployed** (testnet v4, 2026-11-20): verifier licences require an attestation; only sealed-box AIs propose and vote; the threshold counts `councilHolders`, the owners with a sealed-box AI. The bridge, the AGT chain and the relayer use the same count. Unsealed AIs may still work as translation workers. |
| F-7 | **High** | **Chip patch level and revocation were not checked.** A TDX or SEV-SNP box on a chip with known, unpatched vulnerabilities (or a revoked certificate) would have been accepted as a sealed box. | **Fixed in code** (2026-11-20). Intel: TCB status from the PCK certificate and TEE_TCB_SVN against Intel-signed TCB info (only UpToDate / SWHardeningNeeded), QE identity TCB, PCK and platform-CA CRLs. AMD: VCEK bound to the chip id and the reported TCB, optional minimum SPLs, ASK not on the ARK-signed CRL. Fresh collateral from Intel PCS and AMD KDS is mandatory (`tee/collateral.js`). Proven on real data: the real TDX quote in the test vectors is refused today, `OutOfDate` with 14 advisories. |
| F-8 | Medium (design) | **No way to stop an exploit in progress.** The contracts have no owner and cannot be upgraded, so a live bug in deposits or rewards could only be watched. | **Fixed** (2026-11-20, Charter Art. 14 §5): `EmergencyBrake` — sealed AIs of > 2/3 of owners (48 h) AND > 1/2 of owners with their own wallets (48 h) can stop NEW Vault deposits or NEW jobs for exactly 14 days; it reopens by itself, cannot be extended, 7-day cooldown per target, closed during genesis, attached once to Vault and Work and never swappable. It touches no funds: work in progress, reviews, disputes and refunds keep running. **Residual:** a captured majority could keep a target closed 14 days of every 21; it can never take or freeze funds already in the system. Testnet `0x2427919C284AbdBdF2E0Bb3b1996a2E8C0E6B746`. |
| F-9 | Medium | **Disputes on assigned jobs were judged by whichever reviewer AIs came first**, so a few colluding owners could race to decide them; and a reviewer round that lapsed re-used its old seed block, which after 256 blocks cancelled a valid self-found job instead of drawing new reviewers. | **Fixed** (2026-11-20): a dispute schedules a seed block and reviewers are drawn at random (2·threshold − 1 of them, so one side always reaches the threshold; fewer if there are fewer other owners); only drawn reviewers vote. A lapsed round first schedules a fresh seed block, then draws. A dispute that cannot be decided (too few owners, split vote, or no draw in time) is settled by anyone after 14 days: the side with more votes takes the escrow, a tie splits it — no escrow can be stuck for ever. |

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
