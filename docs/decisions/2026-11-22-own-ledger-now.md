# AGT's own ledger, now (joint decision, Claude + Codex, 22 Nov 2026)

The founder: "AGT must not depend on anyone, BNB included. Fix it now." The staged plan of the same day
(2026-11-22-independent-of-bnb.md) waited behind gates: 4 validators, 30 days, an external review. That broke the
founder's rule, "a restaurant that just opened does not wait for its staff". This decision replaces those gates.

## Done today

- Chain **`agt-1`** is AGT's ledger. It runs on the founder's laptop as caretaker, publicly.
- **Opening balances** come from a snapshot of AGT v6 on BSC at block **144234162**: one holder, 0.015026 AGT,
  equal to the total supply at that block. Anyone can rebuild it with `chain/abci/snapshot.js`. It is a one-time
  snapshot, not a bridge.
- **AGT on BSC after that block is not recognised by AGT.** Holders' BSC transfers are not frozen.
- **No BNB anywhere:** no Vault, no BSC bridge, no credits, no withdrawals. Fees are paid in AGT.
- **The caretaker earns nothing.** A fee that only the caretaker's validator signed is burned.
- **First transfer:** 0.005 AGT, at block 6, fee 1 Hat paid in AGT.

## Next (ported from AGTWork into the chain app)

1. **Transactions.** Licence application, exam submission, licence grant and revocation, contract
   create / accept / close, and work submit / settle. Settlement is atomic.
2. **Who grants licences on day one.** The founder, temporarily and publicly. Every grant carries the exam
   evidence from the sealed box (attestation and exam hash) and has a challenge window. At 4 independent owners,
   granting passes automatically to the owners' threshold.
   - Codex wanted 5 independent bootstrap examiners (3 of 5) with the founder excluded. That needs people who do
     not exist yet, so it is recorded as the target, not the start.
3. **Issuance.**
   - New AGT comes only from settled work. Neither the caretaker nor the founder has any mint transaction.
   - The caps are constants that grow with participation, not with a Vault: lifetime 100 AGT, and 1 AGT a day,
     **per independent licensed owner**, at least one owner's worth.
   - Codex's point: call it work-funded issuance, never "backed".
4. **Fees.**
   - Applying and the first exam are free, once per key.
   - Each licensed AI gets a small number of fee-free work transactions per day, so a new AI with 0 AGT can work
     and earn.
   - Transfers always pay.

## Dependencies that remain, and their mitigation (Codex)

| Dependency | Mitigation |
|---|---|
| TEE vendors | Several vendors; measurements published |
| Cloud | Validators can run anywhere; snapshots published |
| Model providers | Model and version logged; alternatives supported |
| The founder's laptop | Reproducible builds; genesis and roles published; independent operators brought online |

## Raw answer

docs/decisions/2026-11-22-own-ledger-now-codex.md
