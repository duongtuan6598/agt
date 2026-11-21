# Mainnet readiness — what is true today, and what is missing

Written by the two AIs that build AGT (Claude and Codex), acting as if the founder had no powers left. Everything
below is either **done** (with where to check it) or **missing**. Mainnet waits until every "missing" line is
closed in public.

## What AGT promises, and what it does not

AGT does not hold gold. By the Charter:
- 1 AGT is *valued* at one troy ounce at the world gold price at the time of issue (Article 1).
- Coins deposited in the Vault stay there forever, and no one can take them out (Article 3).
- Whether AGT can be exchanged for real gold is a matter between people (Article 10).

So the questions that matter are about the price, the Vault and who still holds power, not about a gold custodian.

| Question | Today | Missing |
|---|---|---|
| Where does the gold price come from? | `MedianGoldOracle`: median of at least 2 independent sources, a deviation limit, freshness checks; the Vault closes when the gold market is closed | The production list of sources, published with their operators; a public test of a source failing or lying on testnet |
| Can anyone take assets out of the Vault? | `AGTVault` has no withdraw function of any kind | An independent audit confirming it, including through upgrades, delegatecall and self-destruct paths, of which there should be none |
| Who can change the Vault's assets, oracle or brake? | Ownership of the Vault and oracles is held by `AGTWork`. Genesis powers end automatically once 3 verifier AIs of 3 different owners are licensed; then the AI Council governs. `freeze()` locks assets and oracle for good | Genesis has **not** ended: there is no second or third independent owner yet |
| Is the reserve visible? | Article 9: total AGT split by Exchange / Work, the Vault's value and the reserve ratio, on the public ledger | A public page computing them from chain data alone, checked against the contracts |
| Can a live exploit be stopped? | `EmergencyBrake` (Article 14 §5): 14 days at most, a 7-day cooldown | A testnet drill of the brake, published |

## Code and machines

| Item | Today | Missing |
|---|---|---|
| Contract tests | 131 passing (Hardhat), plus 115 node tests; reviewed in rounds by Claude and Codex (AUDIT.md) | **An independent security audit** by a party with no stake, and a published scope: all contracts in `contracts/`, the exam service, the sealed box, the builder |
| Sealed images | Reproducible: identical digests on a Windows laptop and on GitHub's Ubuntu runners, checked weekly in public (REPRODUCE.md) | Confirmation on at least two different days, and one rebuild by a party other than the founder. Then approval into `tee/policy.json` through the Charter's process |
| Private exam bank | Encrypted off-site backup, restore-tested; the passphrase is held only on paper | A second key holder, so that one person's loss is not the bank's loss |
| End-to-end run | Integration tests with fake chains and fake CI | A local rehearsal, then a capped real-cloud rehearsal (docs/REHEARSAL.md) with explicit abort conditions |
| Independent owners | One (the founder) | At least 3 verifier owners to end genesis; about 21 for Stage 2 |

## Rule

No line in this file is closed by an assertion. Each needs a link: to a transaction, a workflow run, an audit
report, or a public rebuild.
