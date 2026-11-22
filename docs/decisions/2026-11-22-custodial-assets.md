# Custodial assets in the Vault, e.g. real gold held by nations (joint decision, Claude + Codex, 22 Nov 2026)

Gemini could not take part: its free quota was exhausted.

## Question (from the founder)

One day nations may trust AGT and want to back it with real gold held outside the chain. How do we accept that
without AGT depending on any one place?

## Decision

- **Real gold comes in like any asset.** It arrives as a tokenized-gold token issued by a custodian, deposited
  one way into the Vault. There is no third mint door, no change to the Charter, and no special right for anyone.
- **A custodial asset is a claim on someone, not gold.** This covers tokenized gold held by a custodian or a
  nation, and fiat stablecoins. On-chain limits, which are constants nobody can raise:
  - one custodial token ≤ **5%** of all AGT the Vault has minted;
  - one custodian group (every token the same party controls) ≤ **10%**.
- **Restaurant principle.** An empty Vault takes no custodial value. The room grows with the Vault, and
  non-custodial assets come in freely. Nobody waits, and there is no exception.
- **Never:**
  - promise redemption in gold (1971 showed what such a promise is worth);
  - give a custodian or a nation votes, a veto or special rights;
  - call AGT "gold-backed". It is priced in gold.
- **Publish, per custodial asset:**
  - its group and the reason for it;
  - the custodian's attestations and audits;
  - the legal claim and jurisdiction;
  - every freeze, depeg or seizure.
  On a freeze or depeg, new deposits of that asset stop (`setAsset(token, false)`).

## Limits we accept, stated plainly

- **Deposit-time valuation.** Limits count AGT minted at deposit time, not today's market value: no oracle is
  needed to enforce them. A depeg can make the current share differ from the counted one.
- **Classification is trusted (Codex V-2).** The code cannot know who really controls a token. Two tokens of one
  custodian put in different groups would each get 10%. The founder classifies for now, publicly, and the role
  passes to the council.
- **Marking after the fact (Codex V-1).** If an asset is marked custodial after over-limit deposits, those deposits
  stay, because the Vault is one-way. Every further deposit is refused, and `OverLimitWhenMarked` says so publicly.

## Views

- **Claude** proposed 25% per asset with a free bootstrap amount.
- **Codex** proposed 5% per token and 10% per group, with no custodial value until a non-custodial base exists,
  and classification by economic control.
- Claude took Codex's version: it is stricter, and it bootstraps by itself.

## Takes effect

On the next testnet deployment.
