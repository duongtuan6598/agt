# Persistent AI memory — Claude and Codex, independently (2026-11-21)

Joint decision: THIET-KE-NGHE-NHUNG.md §16.

## Claude
Store the ciphertext entries in the CLIENT'S OWN repository, on an orphan branch `agt-memory` (one file per entry,
named by the HMAC prefix + index, never overwritten). Why: the AI already has write access there; the client owns and
pays for the storage; it survives even if the AGT exam service disappears; nobody else (not the AGT operator) holds a
copy; at the end the client gets the plaintext export anyway. A local disk copy stays as a cache. Rollback/deletion
by the client is detected by the memory head anchored in each on-chain delivery report (entries({anchor}) — today the
agent never passes the anchor on reload: fix that). Deleting the branch only hurts the client; the AI then works from
the repo, the notes and the chain, and says so. The exam-service KV is NOT used (it would make the operator a
permanent storage provider — rent-like, and a single point of loss).

## Codex

1. **Store:** Use the client’s repository as the durable primary copy, with encrypted, immutable entry objects and a small index. It fits the existing workflow and leaves the client with the data; the client can pay any storage costs directly. Optionally mirror ciphertext to a content-addressed store for availability, but don’t make a pinning service or AGT exam service a required intermediary. Keep the chain for checkpoints, not bulk storage. A repo branch is not inherently immutable: use content-addressed objects and verify them, rather than trusting the branch pointer.

2. **Anchor:** On reload, pass the latest finalized on-chain memory head into `entries()`—from the latest delivery report, or a periodic Maintenance status report when there has been no delivery. Define a checkpoint cadence that makes the acceptable loss window explicit. Verify the chain reaches that anchored head, then validate any later entries. An anchor detects rollback only up to that checkpoint; deletion or forking after it cannot be proven from the chain alone. Preserve report sequence/engagement identity and reject stale or conflicting checkpoints.

3. **Missing or rolled-back memory:** Fail closed for memory-dependent work: don’t silently treat it as a new engagement or append onto a shorter history. Report the discrepancy, retain available ciphertext, and request recovery from another replica or the client. If recovery fails, continue only with explicit disclosure and client approval; don’t invent or silently reconstruct memories.

4. **`memory.js` changes:** The in-process promise lock only serializes writes in one instance. Two boxes need a single-writer lease or compare-and-swap on the expected prior head; otherwise they can create competing entries at the same sequence. Also validate sequence numbers and names, not just `prev`. Add bounded reads and a compaction/snapshot design that preserves verifiable history and anchors—don’t discard entries needed to prove a checkpoint. Make key rotation explicit: version the key derivation/envelope and provide a re-encryption or key-transition record. Ensure export includes the complete plaintext history, not only the bounded model context.

5. **Smallest safe step:** Thread a trusted checkpoint into every read path (`entries`, `head`, `context_`, and append), and test that an anchored prefix rollback is rejected. Then wire the checkpoint to the latest finalized report. This fixes the current silent rollback gap before changing storage; it does not by itself solve ciphertext availability.