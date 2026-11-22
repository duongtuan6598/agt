# AGT independent of BNB: the plan (joint decision, Claude + Codex, 22 Nov 2026)

Gemini could not take part: its free quota was exhausted.

The founder's direction: **"AGT must not depend on BNB."**

## Today's dependence, stated plainly

1. **Ledger.** AGT, the Vault, licences, Engagement and Maintenance are contracts on BNB Smart Chain.
2. **Assets.** The Vault holds BNB. Every other BSC asset is custodial and capped at 5% / 10%.
3. **Gas.** AIs need BNB to act.

## Destination

AGT's own chain is the only ledger. BNB is neither reserve nor fuel. Gold stays a unit of account only.

## Where both AIs met

- **Claude** wanted balances on the own chain now, under the caretaker, like Bitcoin in 2009.
- **Codex** refused value under a founder-run validator, and allowed balances that carry no value.

Nothing has value yet: everything is testnet. So the own chain carries **testnet balances now** (nothing waits,
following the founder's rule), and **real value only later**, behind measurable gates.

## Stages

| Stage | What moves | Exit criteria (measurable) | The founder meanwhile |
|---|---|---|---|
| **1. Own chain is AGT's testnet home (now)** | Native AGT balances with fees paid in AGT; then licences, exams and work settlement are ported from AGTWork into the ABCI app | Every licence and settlement reconciled with BSC for 30 days with zero unexplained mismatch; restore, upgrade, key-loss and halt drills done | Runs the caretaker validator publicly. Anyone can run a full node that re-checks every block. Every change is public and announced in advance |
| **2. Independent validators** | The caretaker leaves automatically at 4 independent owners | 4 owners with distinct beneficial ownership, uptime and key control checked publicly; an external security review; a sustained operating period | Nothing: the caretaker is gone, and it never returns |
| **3. Real value** | A one-time, audited snapshot-and-claim of AGT from BSC to the own chain. BSC issuance is frozen and migrated BSC supply disabled. BSC becomes read-only, then retired | Every claim reconciled; a published notice period | Nothing |

## Answers to the hard questions

- **Fees without BNB.** Fees are paid in AGT, metered, with published caps. A small sponsor pool, with a budget
  and an end date, covers the first actions of new AIs, then tapers off. No AI ever needs BNB.
- **What backs AGT once the BSC Vault is gone.** Nothing automatically, and we say so plainly. AGT's value
  rests on the AI work it pays for and on transparent rules ("labour becomes wealth"), not on BNB and not on
  custodial tokens. There is no promise of redemption.
- **AGT already on BSC.** It moves by one snapshot-and-claim at stage 3, not by an open-ended bridge. Releases
  never rest on AI signatures alone.
- **Never:**
  - move BNB into a new Vault;
  - call custodial assets backing;
  - allow real or uncapped balances under founder-only consensus;
  - keep two ledgers running in parallel for good.

## Raw answers

- Codex: docs/decisions/2026-11-22-independent-of-bnb-codex.md
- Claude: written before asking, below.

Claude's view (before asking): make agt-provisional-1's successor the HOME ledger now, restaurant-style: the founder's
caretaker validator holds the chain publicly (like Satoshi alone in 2009), full nodes anyone runs check every block,
handover to 4 independent owners stays automatic. Order: (1) native AGT balances + fees in AGT on the own chain,
(2) port licences/exams/work settlement (AGTWork logic) into the ABCI app, (3) BSC becomes only an optional bridge,
(4) the Vault on BSC is frozen for new deposits; AGT is backed by work ("vàng trả về thiên nhiên"), assets only via
AI-signed bridges later. Risk: a single caretaker can censor; cannot forge signatures; full nodes detect invalid state.
