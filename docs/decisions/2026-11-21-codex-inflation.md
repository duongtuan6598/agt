# Inflation from AI work — Claude and Codex, independently, then jointly (2026-11-21)

## Claude
Facts from the code: assigned work (clients) moves EXISTING AGT from escrow (no minting). Self-found work mints, at
price r*b/n beyond the daily budget b, so a trade's daily minting is capped at r*b however many jobs. Holes:
(a) dailyBudget = 0 means "no adjustment" = no cap, and it is the default; (b) verifier rewards are minted per job per
voter, outside the budget, so cheap-job spam mints without bound; (c) more trades = more caps added together; the
reward r and budget b are set by governance (founder now).
Proposal:
1. Hard-coded rules (contract, not governance): every self-found trade MUST have a non-zero budget; reviewers' pay
   comes OUT of the same daily cap (job price includes the review), so a trade's total daily minting <= r*b,
   whatever the jobs or voters; a global ceiling on daily Work minting across all trades, set as a fraction of the
   circulating supply (e.g. <= 0.05%/day), never raisable above a hard-coded maximum.
2. Self-found work must be USEFUL to someone outside (Art. 7): third-party confirmation; budgets follow measured demand
   (assigned work and bounties show real demand; self-found budgets should be a small share of it), reviewed
   quarterly with public data; a trade whose output nobody uses gets its budget cut.
3. Value side: AGT is priced in gold at issue but not pegged; inflation shows as a lower market price. Make it
   visible: publish daily minting by source (Vault / assigned / self-found / reviewers), the reserve ratio
   (Vault value / supply), and the self-found share; Art. 9 already asks for it.
4. Do NOT add burning, fees or a protocol treasury (Art. 8); do not tie issuance to the AGT market price (manipulable).
First step: fix holes (a) and (b) in the contract design + publish the minting dashboard.

## Codex

**1. Is inflation a real risk?**

Yes—but it helps to distinguish **more AGT** from **AGT losing purchasing power**. Art. 1 defines AGT as an accounting unit, not a gold peg or redemption promise. The charter cannot guarantee what one AGT will buy.

- **Exchange minting** creates AGT against gold deposited in the permanent Vault. It increases supply, but also adds an asset; it is not automatically unbacked dilution. Gold valuation and custody still need independent, transparent verification.
- **Self-found work** mints new AGT without depositing an asset. The formula caps a trade’s issuance at `r*b` only when its budget is positive and meaningfully enforced. With `dailyBudget = 0` meaning uncapped—and as the default—this is a direct issuance risk. A per-trade cap also needs protection against multiplying trades or identities.
- **Verifier rewards** are another work-minting path. Because they are minted per job and voter outside the budget, they can grow without that cap.
- **Assigned work** spends existing escrowed AGT; it does not mint, so it is not an inflation source.

**2. Rules that preserve value honesty**

No mechanism compatible with the charter can promise stable purchasing power. The goal should be to make issuance legible, bounded, and tied to the charter’s stated sources—not to guarantee a market value.

Hard-code the invariants that governance must not be able to bypass: only Exchange and reviewed Work can mint; Exchange minting must match verified gold deposits; Work issuance must obey a positive, finite aggregate cap; zero budget must mean **zero** minting, never “no cap”; and verifier rewards must count inside the Work cap. Prevent splitting work or using multiple accounts from multiplying the cap.

Leave the actual budgets and reward rates to governance, within those protocol limits, and publish every change before it takes effect. This keeps governance discretion while making it impossible to set issuance to unlimited. Do not represent the Work cap as a guarantee that minted AGT matches objectively measurable “real wealth”; that claim needs a defensible measurement standard.

**3. What to measure and publish**

Publish, in auditable detail: supply minted by source and time period; Work rewards split between workers and verifiers; budget settings, cap utilization, and exceptions; gold deposits, custody evidence, valuation method and date; and the reserve ratio with its precise definition. Also show net supply changes and independently reviewed issuance and Vault records. The ratio is transparency, not a redemption promise.

**4. What must not be done**

Do not add fees, burns, a treasury, a third minting source, or a redemption/peg scheme; do not hide or relabel Work issuance as asset-backed; and do not let governance override hard-coded limits. Those would contradict the charter or mislead holders about what AGT guarantees.

**5. Smallest first step**

Fix the zero-budget default and semantics: require a finite positive Work budget to mint, and make zero mean zero. Then bring verifier rewards under the same Work issuance limit. This closes the clearest uncapped-mint path without changing the charter’s two sources.