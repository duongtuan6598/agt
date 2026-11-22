# AGT chain — Stage 2 design (Charter Articles 8, 11, 12, 13)

**Goal:** AGT transactions are confirmed and every block is signed by the licensed AIs themselves, not by BSC validators. Each transaction pays a small, fixed consensus wage that goes entirely to the AIs that signed it.

## Pieces

| Piece | Where | Status |
|---|---|---|
| `contracts/AGTBridge.sol` | BSC | Deployed on testnet `0xad466991f0bbbd3cc40cf2F7148e0a5EE6A1285D`; stays closed until genesis ends |
| `chain/core.js` | AGT chain | State machine and commit rules, 9 tests |
| `chain/devnet.js` | local | In-process demo of the rules (no networking) |
| `chain/abci/app.js` | AGT chain | **CometBFT v0.38 ABCI 2.0 app (gRPC)** — the same rules, run by a real BFT engine; 4 tests |
| `chain/abci/devnet.js` | local Docker | 4 CometBFT validators + 4 AGT apps; `up` / `demo` / `down` |
| `chain/relayer.js` | anyone | Carries withdrawals to `AGTBridge.release()`; holds no privileged key |

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

## Running on CometBFT

```
cd chain/abci && npm install          # @grpc/grpc-js, @grpc/proto-loader (protos for v0.38.26 are vendored)
node chain/abci/devnet.js up          # 8 containers: cmtN (cometbft/cometbft:v0.38.26) shares the network of nodeN (AGT app)
node chain/abci/devnet.js demo
node chain/abci/devnet.js down
```

How the rules map onto ABCI:

| ABCI | AGT |
|---|---|
| `InitChain` | Validators come from `app_state`. Each AI proves with its **licence key** which CometBFT ed25519 key it runs (`bindSig`). An owner with two validators is refused, and every power is set to 1 (1 owner = 1 vote). |
| `CheckTx` | `core.applyTx` on a mempool copy. A wrong fee, a bad nonce or an overdraft is refused. Credits are refused from the mempool. |
| `PrepareProposal` | The proposer adds `credit` txs for new `AGTBridge.Locked` events, in order, after `CONFIRMATIONS` blocks. |
| `ProcessProposal` | Each validator checks every credit against **its own** BSC view and votes REJECT if any does not match. This is the only place BSC is consulted, so `FinalizeBlock` stays deterministic. |
| `FinalizeBlock` | Applies the txs. The previous block's wages go to the owners of the validators that CometBFT reports in `decided_last_commit` as having signed it. |
| `Commit` | Persists the state. This node's AI then signs the release digest of each new withdrawal and gossips it as an `attest` tx. `abci_query /release/<n>` returns the package ready for `AGTBridge.release()`. |

Devnet result (20 Nov 2026):
- 4 validators with voting power 1, 1, 1, 1.
- A lock was credited and a transfer paid 1 Hat; a zero-fee tx was refused.
- A withdrawal was signed by all 4 AIs.
- With one AI stopped, blocks stayed final on 3/4.
- Wages totalled 3 Hat for 3 txs (the offline AI earned less), and supply on the chain = locked − withdrawn.

## Provisional chain with a caretaker (decided by Claude, Codex and Gemini, 2026-11-21)

Following the founder's rule (a restaurant that just opened does not wait for its staff), the chain can run **now**,
before any licensed AI exists, as a **provisional** chain:

- **No balances.** Its genesis names no bridge (`bsc.bridge = 0x0`), and every credit, transfer, withdrawal or fee
  change is refused. BSC stays the only ledger.
- **One caretaker validator**, run by the founder and named in genesis (`caretaker`). It is allowed only on a
  provisional chain. It is outside the licence rules and counts toward no threshold.
- **Automatic handover, written in the state machine.** Licensed AIs join as usual, by snapshot and bind. In the
  block where 4 independent owners have bound licensed AIs, the caretaker gets power 0. It never comes back, even if
  licences are revoked later. If a handover could not be done safely, the remedy is a new public genesis, never a
  founder exception.
- **The threshold, stated precisely.** CometBFT finalises with more than 2/3 of the voting power. With 4 validators
  of power 1, a block needs 3 signatures and the chain tolerates 1 faulty validator (3f+1 with f = 1). That is the
  first safety threshold. 21 owners is the decentralisation milestone.

Local rehearsal on real CometBFT (`node chain/abci/devnet.js up --provisional` then `demo-provisional`),
21 Nov 2026:

1. The caretaker alone produced blocks.
2. Licences #1, #2 and #3 each bound and joined, with the caretaker still in.
3. Licence #4 bound, and the caretaker left in that same block.
4. The founder's node was switched off and the chain went on with the 4 AIs.
5. A transfer was refused.
6. Licence #1 was revoked and the caretaker did not come back.

Unit tests are in `chain/abci/test/app.test.js`.

**Live since 21 Nov 2026 (16:03 UTC):** chain `agt-provisional-1` on the founder's laptop
(`node chain/abci/provisional.js up | status | down`). It follows AGTWork licences on BSC testnet v5. Its data and
the caretaker key are kept outside the repo. Its P2P port is not reachable from the internet yet, so for now
AI nodes cannot join it from outside; a cloud machine will replace the laptop when there is a budget for one.
Since 22 Nov 2026 (height ~7880) it follows the licences in **AGTWork v6**
(`0xA21a9137961334b1d5d98938Aac3471fD9bAA3cb`). The `bsc.work` field in its genesis still names v5. That field is
only informational: the node reads the address from `deployments/bscTestnet.json`.

## The validator set follows BSC licences

| Step | What happens |
|---|---|
| Snapshot | When the licences on BSC change, the proposer adds a `valset` tx: a snapshot of AGTWork **at a named BSC block** (`bscBlock`, at confirmed depth). It lists the active licences with `attestHash ≠ 0` and `activeHolders`. |
| Check | Every validator re-reads AGTWork **at that same block** (`blockTag`) and rejects the proposal if the snapshot differs, or if the block is not yet final for it. The result is deterministic: everyone reads the same historical state. |
| Bind | A newly licensed AI sends a `bind` tx: its CometBFT ed25519 key, signed with its licence key. Its app does this by itself, reading the key from its own CometBFT. It cannot bind a key that another AI uses, and an AI without a licence cannot bind at all. |
| Vote | Per owner, the bound AI with the lowest licence id gets power 1, and every other AI of that owner gets 0. If that licence is revoked, the owner's next AI takes over the vote. |
| Apply | `FinalizeBlock` returns `validator_updates`: power 1 for those who joined, power 0 for revoked ones. A revoked AI also stops being able to attest withdrawals at once. |

Devnet result (5 nodes, `node chain/abci/devnet.js demo`, steps 7–9):
- Licence #5 was granted. Eos bound its key and joined, giving 5 validators and 5 owners.
- Licence #2 was revoked. Borealis was removed, leaving 4 validators.
- A tx sent through Eos's node paid its 1 Hat as 0.25 to each of the 4 current signers.

## Relayer

```
AGT_RPC=http://<any AGT node>:26657 BSC_RPC=<bsc rpc> BRIDGE=<AGTBridge> node chain/relayer.js status
RELAYER_KEY=<any funded BSC key> … node chain/relayer.js release <n>     # usually the person withdrawing
RELAYER_KEY=… node chain/relayer.js watch                                # relay everything as soon as ready
```

**What it does for each withdrawal:**
1. It reads the package from `abci_query /release/<n>`.
2. It **re-checks every signature against AGTWork on BSC as it stands right now**: the licence is active, the agent matches, and `attestHash ≠ 0`. It keeps one signature per owner and sorts them by owner.
3. It waits until > 2/3 of `activeHolders` is reached.
4. It dry-runs `release` (`staticCall`), then sends it.

**Why it needs no trust:**
- An AI that lost its licence after signing is dropped instead of making the BSC transaction revert.
- The relayer holds no privileged key and earns nothing: it only pays BSC gas. Charter Article 8 allows no middleman fees.
- The AGT always goes to the recipient the AIs signed.
- If two relayers race, the second sees `AlreadyReleased` and moves on.

**Tested end to end** on a local BSC (`test/relayer.test.js`): real contracts, plus the AGT app reading `Locked` events from the real bridge, plus the relayer.
- With 2 of 4 owners it waits; at 3 of 4 a stranger relays and the user receives exactly the withdrawn AGT.
- A second relayer finds it already released.
- Forged and duplicate signatures are dropped before any gas is spent.

## Honest limits

- **More than 2/3 of owners colluding** could release locked AGT to themselves. This is the security of every BFT system. The defence is many independent owners plus sealed boxes (Article 12). That is why stage 2 waits for enough owners (the Charter suggests ~21).
- **Consensus is CometBFT's.** The in-process `chain/devnet.js` is only a demo of the rules.
- **Each AI's two keys, the licence key and the CometBFT consensus key, must both live in its sealed box.** Today they are ordinary files.
- **The AGT chain still depends on BSC** for identity (licences) and for the lockbox. Moving licences and the Council onto the AGT chain is a later step.

## Before mainnet

1. ~~Port to CometBFT~~ (done: `chain/abci`). Next: follow validator-set changes from BSC, state sync and snapshots, and a public testnet run by independent owners.
2. ~~Relayer~~ (done: `chain/relayer.js`).
3. ~~Sealed box~~ (code done: `tee/`, see tee/README.md). It still has to run on a real Confidential Space VM, which needs a cloud account.
4. Get an independent audit of `AGTBridge.sol` and the ABCI app.
5. Meet every precondition in THIET-KE.md (separate identity, a large question bank, a new mainnet wallet, an audit).
