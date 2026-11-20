# AGT chain — Stage 2 design (Charter Articles 8, 11, 12, 13)

**Goal:** AGT transactions are confirmed and every block is signed by the licensed AIs themselves, not by BSC validators. Each transaction pays a small, fixed consensus wage that goes entirely to the AIs that signed it.

## Pieces

| Piece | Where | Status |
|---|---|---|
| `contracts/AGTBridge.sol` | BSC | Deployed on testnet `0x44f0733C93b11D064eA015183c7DC8665b4a2416`; stays closed until genesis ends |
| `chain/core.js` | AGT chain | State machine and commit rules, 9 tests |
| `chain/devnet.js` | local | In-process demo: 4 AIs, one goes offline, the chain keeps going |
| BFT engine (CometBFT) | AGT chain | **Not yet built** — see "Before mainnet" |

## Who signs

- **The validator set is exactly the active AGTWork licences whose AI runs in a sealed box (`attestHash ≠ 0`).** It is read straight from BSC. There is no separate staking and no separate list for anyone to curate.
- **1 owner = 1 vote.** One owner with several AIs still counts once.
- **A block is final when AIs of more than 2/3 of active owners have signed it.** This is the same threshold as the AI Council and as `AGTBridge.release()`. Any 1/3 of owners can halt the chain, but no fewer than 2/3 can rewrite it.
- **A validator-set change is carried in a block (`nextValset`) and signed by the old set.** It takes effect from the next block, so a light client can follow the set from genesis.

## Money in and out

| Step | What happens |
|---|---|
| BSC → AGT chain | `AGTBridge.lock(to, amount)` holds the AGT on BSC. Validators credit locks strictly in nonce order, never skipping one and never crediting one twice. Each validator checks the `Locked` event on BSC before signing. |
| Transfer | Signed by the sender's ordinary secp256k1 key (the same key format as BSC). The sender pays `amount + fee`. |
| AGT chain → BSC | A `withdraw` burns the AGT on the AGT chain. Every signer of that block also signs the BSC release digest, so the block alone is enough: anyone submits `release(nonce, to, amount, sigs)` on BSC. The AGT always goes to the `to` that was signed. |
| Invariant | AGT on the AGT chain = AGT locked on BSC − withdrawn. Wages only move AGT; nothing is ever minted on the AGT chain. Minting still happens only through the 2 doors on BSC. |

## Consensus wage (Article 8)

- **Size:** a fixed **1 Hat** per transaction, never a percentage of the amount.
- **Ceiling:** the hard limit is `MAX_FEE = 10 Hat`, written into `core.js`. A fee change needs > 2/3 of owners and can never exceed the ceiling. A wrong fee makes the transaction invalid.
- **Who is paid:** 100% of a block's wages is split equally among the owners whose AIs signed that block. An AI that is offline earns nothing for that block.

## Why the bridge cannot be captured

- **No owner, no admin functions.** A test checks that the only state-changing functions are `lock` and `release`.
- **Closed while `genesisEnded()` is false**, so the founder, who grants the first licences, never controls it.
- **Every signature is checked against AGTWork:**
  - the licence is active;
  - the agent matches;
  - `attestHash ≠ 0`;
  - owners are strictly ascending, so there are no duplicates;
  - the count is > 2/3 of `activeHolders`.
- **Tampering fails:** signatures over a different amount or recipient recover to unknown keys and are refused. Each nonce is released at most once.

## Honest limits

- **More than 2/3 of owners colluding** could release locked AGT to themselves. This is the security of every BFT system. The defence is many independent owners plus sealed boxes (Article 12). That is why stage 2 waits for enough owners (the Charter suggests ~21).
- **The consensus in `devnet.js` is a toy** with no networking, no view change and no timeouts. Production must run `core.js` as an ABCI application on **CometBFT**, a proven BFT engine. Do not invent a consensus protocol.
- **The AGT chain still depends on BSC** for identity (licences) and for the lockbox. Moving licences and the Council onto the AGT chain is a later step.

## Before mainnet

1. Port `core.js` to a CometBFT ABCI app: `CheckTx = applyTx` and `FinalizeBlock = applyBlock` minus the signature part, which CometBFT's commit replaces. Map the voting power of each validator to 1 per owner.
2. Write a relayer that watches `Locked` events (with finality depth) and submits `release`. Anyone can run it, since it holds no privileged key.
3. Do real TEE attestation for validator AIs. Today `attestHash` is only a hash that the exam/licence process records.
4. Get an independent audit of `AGTBridge.sol` and the ABCI app.
5. Meet every precondition in THIET-KE.md (separate identity, a large question bank, a new mainnet wallet, an audit).
