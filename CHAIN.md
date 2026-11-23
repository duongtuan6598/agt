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

## agt-1 → agt-2, and the rule that came out of it (23 Nov 2026)

`tools/agt1-follow.js` replays a chain from its genesis on your own machine, through any RPC, and compares its state
hash with each block's. Run against agt-1, **block 1 already disagreed**. While agt-1 was being built, its rules
changed and the node restarted from saved state, so today's code could not rebuild its history: nobody could check
agt-1 independently.

**agt-2 replaces it**, at agt-1 height 2129. It carries the balances (2 accounts, equal to the supply) and the Kho
deposits already credited, so that no deposit is ever credited twice. Its full replay from genesis matches block by
block.

**Rule from now on:** a change to consensus rules takes effect at a published height. Before it counts as done,
`agt1-follow.js` must replay the chain from genesis with the new code.

## The caretaker moves to a server (23 Nov 2026)

The agt-2 caretaker node moved from the founder's laptop to a rented Ubuntu server (2 vCPU, 2 GB RAM). Its public
P2P address is listed in `/.well-known/agt.json` (`ownChain.peers`). The laptop was stopped first, so that no two
nodes ever sign with the same key. Then the data folder was copied, and the chain went on at height 503, where it
had stopped. A full replay from genesis matched all 509 blocks.

- The server's commands are in `chain/abci/vps-node.sh`.
- SSH accepts keys only; password login is off.
- The firewall allows SSH and P2P only; the RPC stays on localhost and is reached through the public door.

## Rules v2 at agt-2 height 1000 (23 Nov 2026), after DeepSeek's review

DeepSeek, newly added to the AIs that decide AGT, reviewed the chain app and found five real problems that Codex had
not (docs/decisions/2026-11-23-review-deepseek-agt2.md). All take effect at **height 1000**, published before it
was reached; before that height the v1 behaviour is kept exactly.

| Finding | Fix |
|---|---|
| D-1 undelivered milestones locked forever once work started | The client takes back a pending milestone after 14 days without delivery (`eng-reclaim`) |
| D-2 a drawn reviewer who never votes strands a dispute or a job | After 7 days the votes cast decide. A tie, or no vote at all, splits a contract milestone; a job with no vote expires and mints nothing |
| D-3 several price reports in one block walk the price without limit | One report per reporter every 600 blocks |
| D-4 if owners drop below 4, the granter got its role back | The role ends for good the first time 4 independent owners hold licences |
| D-5 wages paid to the holder at bind time after a licence changed hands | Wages go to the current holder of the signing AI's licence |
| D-6 `/release` broke on stale attestations | Stale ones are skipped |

The replay check caught a mistake of Claude's before height 1000: the first v2 code wrote a new state field in every
block, which changed the state hash of block 13. Every new field is now gated behind the height, and the full replay
from genesis matches.

## Rules v3 at agt-2 height 3800 (23 Nov 2026)

While the founder grants alone (fewer than 4 independent owners), nobody else could contest a grant, so the one-day
wait only stopped work. From **height 3800** (published at height ~3475): a grant in that period counts at once, and a
grant still waiting counts at height 3800. From 4 owners on, the wait returns, because then other owners read and
contest the evidence.

## Rules v4 at agt-2 height 6000 (23 Nov 2026): AGT's own signatures

From **height 6000** (published at height ~4600), every agt-2 signature must be in AGT's own form
(`chain/sig.js`): made on `keccak256("\x19AGT Signed Message:\n32" ‖ digest)` and written `agt:0x…`. The older form,
borrowed from Ethereum wallets, is refused from then on. AGT's form is accepted at every height, so clients switched
first; before 6000 both count, so every older block replays unchanged. With addresses `agt1…` and the wallet in the
page, nothing a user touches comes from another chain.
