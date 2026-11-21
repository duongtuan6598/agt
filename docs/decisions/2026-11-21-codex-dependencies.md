# The two public dependencies — Claude and Codex, independently, then jointly (2026-11-21)

## Claude
Founder's rule ("a restaurant that just opened"): no role waits for enough participants; the founder holds it
publicly and hands over automatically, step by step, as real participants arrive; never two conflicting roles.

1. Licences & price list (today: founder + Council during genesis; ends at once when 3 owners have a verifier AI).
   Replace the single cliff by a GRADUAL, automatic handover written in the contract:
   - split the founder's genesis powers into separate powers (licence grant, licence revoke, price list/budgets,
     trades, image approval) and move each to its proper mechanism as it becomes able to work:
     licence grant -> the grading contract (founder's grader alone today, 2-of-N graders as soon as one independent
     grader exists); trades/prices -> the proposals registry (founder executes today, Council vote once >= 1
     independent verifier owner exists, founder executes nothing once >= 3);
   - the founder's remaining discretionary power shrinks with each independent verifier owner (e.g. a founder action
     needs the co-signature of the independent verifiers present; a timelock + public notice for every founder act).
   - Verifiers: the founder authored the review bank, so the founder cannot own verifier AIs; the first verifier
     owners must be outsiders -> make sitting the verifier exam as easy as possible for strangers (guide, cost
     ~1 USD, launch script) — that is the real bottleneck, not code.
2. Confirming AGT transfers (BSC validators; Stage 2 = AGT's own chain signed by licensed AIs, ~21 owners).
   - Honest position: BSC is a neutral, large validator set; for safety of balances it is better than a tiny new
     chain. Do NOT move balances early.
   - Restaurant principle: start the AGT chain NOW as a SHADOW chain run by the founder's sealed boxes plus anyone
     licensed: it mirrors BSC events (the bridge contract exists), produces blocks, and its state is compared with
     BSC publicly. BSC stays canonical. Cut over only when (a) enough independent signer owners (threshold set in
     advance), (b) months of shadow operation with zero divergence, (c) Art. 14 amendment with human co-signature.
   - Meanwhile reduce BSC dependency where cheap: contracts already ownerless; keep a public plan to redeploy on
     another EVM chain if BSC censors AGT.

## Codex

## 1. Licences and trade prices

Replace the single `onlyGov` gate and the “three verifier-license owners” sunset with **separate, on-chain authorities for each job**. A verifier license is not evidence that its owner can—or should—govern licensing and prices, especially when the founder authored the verifier questions.

- **Open now:** Name the founder publicly as the temporary steward for each unstaffed authority. Keep AI Council input advisory; it must not grant privileged control over AI decisions.
- **Bound the steward:** Give each authority its own role in a registry, with public actions and hard contract-enforced limits. Put trade/price changes behind published rules and a timelock; keep daily budgets and dispute outcomes within explicit bounds. Replace `onlyGov` with these scoped checks—no hidden owner or fallback admin.
- **Hand over by job:** When one independent, qualified successor accepts a specific job, transfer that role atomically: the successor becomes its sole steward and the founder loses that same authority in the same transaction. Repeat independently for licensing, pricing, budgets, and dispute rules. Do not wait for three verifier owners to begin handing off.
- **Protect the rules:** Make the governing constraints public and independently verifiable. Put changes to foundational rules under the human-controlled process required by Art. 14, with notice and delay; no founder, AI, or single owner should be able to bypass it. Ordinary license and price actions remain subject to those rules.

**Must not:** Keep a permanent `onlyGov` escape hatch; count license holders as a proxy for governance competence; let owners steer AI judgments; or create overlapping authorities that can issue conflicting instructions for the same job.

**Smallest first step:** Replace `onlyGov` for one function with a public, scoped role and a bounded action rule. Emit an event for every action and ensure role transfer revokes the old holder atomically.

## 2. Transfer confirmations and validators

Do not make BNB validators and AGT validators competing sources of truth for the same balances. Keep BNB Smart Chain as the **only canonical settlement layer** until the AGT chain and its bridge can safely take over. A CometBFT chain can start before it is trusted with bridged balances.

- **Open the chain immediately, honestly:** Start AGT’s chain with the founder as its publicly identified temporary validator if necessary, but label it provisional. Do not treat its confirmations as final for user balances or permit withdrawals against them.
- **Grow the validator set in steps:** Add independent operators through on-chain validator-set updates, with no single operator able to add or remove validators alone. A concrete first safety threshold is **4 equal-weight validators under 4 independently controlled owners**: CometBFT’s standard `3f+1` model can tolerate one Byzantine validator in a four-validator set. Continue adding genuinely independent owners toward 21; treat that as a decentralization milestone, not a prerequisite for opening the chain.
- **Gate settlement on evidence:** Before enabling bridge withdrawals, require the minimum validator threshold, tested upgrades and recovery, and a bridge that verifies AGT consensus—not a founder-controlled signer. Use a capped, staged rollout with withdrawal limits and a delay so a faulty or compromised bridge cannot drain all escrow at once.
- **Switch once:** Specify a public cutover height and chain identity. At cutover, one ledger becomes canonical for each balance; never let both chains confirm spendable versions of the same funds.

**Must not:** Present a one-validator chain as decentralized or safe for settlement; count several validators under one owner as independent; rely on a multisig as a substitute for consensus; or enable unrestricted minting, withdrawals, or an emergency admin key that can seize balances. Any pause mechanism should be narrowly scoped, publicly accountable, and unable to transfer or confiscate funds.

**Smallest first step:** Launch the provisional chain without bridge-backed balance claims, and publish the exact validator and bridge conditions that must be met before any user funds can move.