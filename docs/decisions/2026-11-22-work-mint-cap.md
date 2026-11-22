# Limits on AGT minted for work (joint decision, Claude + Codex, 22 Nov 2026)

Gemini could not take part: its free quota was exhausted (HTTP 402). This decision has two voices, not three.

## Problem

AI work mints new AGT with no asset behind it. AGTWork caps each trade per day, but:
- nothing capped the total over many days;
- nothing capped all trades together (the inflation design promised such a cap; AGTWork had no room left for it).

## Decision (in AGT.sol, the single mint door for all trades)

- **Lifetime limit:** mintedByWork <= min(1,000,000 AGT, 100 AGT + mintedByVault / 19). Beyond the 100 AGT
  bootstrap, work mints at most 1/19 of what the Vault minted, so at least 95% of supply came through the Vault.
  This is an issuance limit by counters, not a proof of assets.
- **Daily limit, all trades together:** min(100 AGT, 1 AGT + mintedByVault / 3650) per UTC day.
- **At a limit, nobody is paid first by accident.** What does not fit today is owed. Anyone may call claimWork(to)
  later, and it always pays `to`. While anything is owed, new work pay is queued too. Pay beyond the lifetime limit
  is not owed. The lifetime limit only grows, so every recorded debt is paid in the end.
- **Constants:** nobody can raise them, the founder included.
- **Day one:** the bootstrap pays AIs before the Vault holds anything (the restaurant principle). The shares tied
  to the Vault take over as real deposits come in.

## Why

- **Claude** first proposed 2% of supply a year and a 91% floor, with partial mints.
- **Codex** proposed the 95% floor, a global daily limit, and a queue instead of paying whoever settles first.
- Claude took Codex's version: it is stricter, and the queue respects the rule that nobody is paid first.

## Review (Codex, of the code)

- **W-1** (anyone can redirect owed pay): checked, **not a bug**. claimWork(to) pays `to` its own debt. Tested.
- **W-2** (debt beyond the lifetime limit jams the queue forever): **fixed**, such pay is not owed. Tested.
- **W-3** (claims are first-come, not FIFO): **accepted and documented**. Nobody loses pay.
- **W-4** ("95% backed" is a counter, not proof of assets): **wording fixed**.

## Takes effect

On the next testnet deployment (the AGT address changes, so the whole set is redeployed). That needs the founder's
approval.
