# Reviews of the provisional chain code by Codex and Gemini (verbatim), 2026-11-21

Each finding was checked against the code; see AUDIT.md CH-1..CH-4 and CH-G.

## Codex

### P-1 [High] Empty validator sets leave stale validators active
· **Problem:** The `Object.keys(next).length > 0` guard skips all updates when the computed set is empty, leaving `s.active` unchanged.
· **Scenario:** After the caretaker has retired, all licensed AIs are revoked. `activeSet` returns `{}`, but the last active validators remain active in state and are not removed from CometBFT.
· **Fix:** Handle the empty-set case explicitly. If an empty CometBFT set is unsupported, define a deterministic halt or other explicit terminal policy rather than retaining revoked validators.

### P-2 [High] Genesis does not prevent caretaker/AI key collisions
· **Problem:** `InitChain` does not check that the caretaker key differs from every AI consensus key. `activeSet` assigns the caretaker entry by public key, so a collision overwrites the AI entry; `cmt` is also keyed by consensus address and can overwrite metadata.
· **Scenario:** A genesis with a caretaker key equal to a licensed AI’s key can miscount independent validators and associate that vote with the caretaker identity.
· **Fix:** Reject duplicate consensus keys, including caretaker-versus-AI collisions, before constructing `active`, `cmt`, or `binds`.

### P-3 [Medium] Genesis only enforces one direction of the bridge rule
· **Problem:** `InitChain` rejects a provisional chain with a nonzero bridge, but permits a non-provisional chain with a zero bridge. This does not enforce the stated provisional ⇔ zero-bridge invariant.
· **Scenario:** A zero-bridge genesis omits `provisional: true`; it initializes as a normal chain despite having no bridge.
· **Fix:** Validate the equivalence explicitly, and reject malformed or missing `bsc.bridge` values before calling `lower`.

### P-4 [Medium] Base64 key checks accept non-canonical encodings
· **Problem:** Checking only `Buffer.from(value, "base64").length === 32` is permissive: Node’s decoder may ignore invalid characters or accept non-canonical encodings. The raw string is also used as the validator-set key.
· **Scenario:** Different textual encodings can decode to the same 32-byte key but compare as distinct strings in `activeSet` or collision checks, producing inconsistent key handling.
· **Fix:** Require a canonical base64 encoding and verify round-trip equality (`decoded.toString("base64") === value`) for caretaker and AI keys.
## Gemini

Review of the provisional chain implementation in `chain/abci/app.js`:

### P-1 [Critical] Non-deterministic Serialization and State Persistence
**Where:** `Info()`, `InitChain()`, and state persistence (e.g., `Commit`).
**Problem:** The state `s` contains `BigInt` values (`s.balances`, `s.supply`, `s.pendingWage`) and objects (`s.active`, `s.binds`, `s.cmt`) where key order is not guaranteed. Standard `JSON.stringify` (likely used in `appHash` and for `STATE_FILE`) throws on `BigInt` and is non-deterministic for object keys.
**Scenario:** A node crashes when attempting to persist state to `agt-state.json`, or nodes produce different `app_hash` values for the same logical state because of varying key order in `s.active`, causing a consensus split.
**Fix:** Use a deterministic serialization library (e.g., `json-stable-stringify`) and a replacer that handles `BigInt` by converting them to strings.

### P-2 [Critical] Non-deterministic Wage Distribution (Dust)
**Where:** `FinalizeBlock` wage distribution (Lines 341-344).
**Problem:** The remainder of the wage division (`s.pendingWage % owners.length`) is given to the first element in the `owners` list. If `owners` is derived from non-deterministic sources like `Object.keys(s.active)`, different nodes will reward different owners with the remainder.
**Scenario:** A permanent `appHash` mismatch occurs between nodes as soon as the first non-zero wage is distributed among multiple owners, breaking consensus.
**Fix:** Ensure the `owners` list is sorted (e.g., by Ethereum address) before iterating to distribute wages.

### P-3 [High] Permanent "No Balances" (Provisional Mode)
**Where:** `FinalizeBlock` (Line 371) and `applyAny` (Line 152).
**Problem:** `s.provisional` is set at genesis but is never updated to `false` when the caretaker retires.
**Scenario:** After 4+ independent owners join and the caretaker retires, `applyAny` continues to throw errors for `transfer`, `withdraw`, and `credit` transactions because `s.provisional` remains `true`. The chain is stuck in a "no-value-transfer" state indefinitely.
**Fix:** In `FinalizeBlock`, set `s.provisional = false` at the same time `s.caretaker.retired` is set to `true`.

### P-4 [High] Caretaker Key Collision in InitChain
**Where:** `InitChain` (Lines 218-231).
**Problem:** `InitChain` does not verify that the caretaker's `pubKey` is unique and not already used by one of the genesis `g.validators`.
**Scenario:** If a genesis validator shares a key with the caretaker, the caretaker entry overwrites the validator in the `cmt` map (line 229). This breaks `activeSet` logic and the counting of independent owners, potentially preventing the caretaker from ever retiring or causing incorrect power updates.
**Fix:** Throw an error in `InitChain` if `g.caretaker.pubKey` matches any key in `g.validators`.

### P-5 [Medium] Non-deterministic Validator Updates Order
**Where:** `FinalizeBlock` (Lines 374-375).
**Problem:** The `validator_updates` array is populated by iterating over `Object.keys(s.active)` and `Object.keys(next)`, which has no guaranteed order for base64 strings.
**Scenario:** Different nodes return the same validator set updates in a different order. This causes non-determinism in block results, logs, and any block-level hash that includes the `FinalizeBlockResponse`.
**Fix:** Sort the `validator_updates` array by public key before returning it.