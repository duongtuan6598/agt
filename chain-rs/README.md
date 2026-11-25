# agt-2 in Rust

The rules of AGT's chain agt-2 (today in `chain/abci/app.js`), rewritten in Rust. It replaces the JavaScript only
once it gives **the same app hash at every height**, replaying the whole chain from genesis.

| Step | State |
|---|---|
| 1. Canonical JSON and hash, `agt1…` addresses, AGT signatures (and the older form before rules v4) | done: matches the JavaScript on shared vectors, and on the live state of height 45695 |
| 2. Genesis (InitChain) and the state file | next |
| 3. Every transaction type, rule versions v2–v10 by height | |
| 4. ABCI server for CometBFT, run beside the JavaScript node, then replace it | |

```
node chain-rs/make-vectors.js      # vectors from the JavaScript rules
cd chain-rs && cargo test           # the Rust rules must match them
cargo run --bin agt-hash -- <state file>
```
