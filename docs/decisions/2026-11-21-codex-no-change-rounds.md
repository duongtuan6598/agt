# Codex review of the rehearsal fixes (verbatim), 2026-11-21

Both findings were accepted and fixed (AUDIT.md P-1, P-2). Joint rule: an empty or unchanged answer is a failed round of the AI; when the rounds run out the AI admits failure instead of asking reviewers, and the client reclaims under the contract's lateness rule.

### P-1 [Medium] Empty model output can stall a no-change round

Where · `attempt()` returns early when `!a.files.length`, without updating state. Problem · After a no-change round, the next attempt can return no files; each later `advance()` then retries that same round, so `ROUNDS` is never reached. Scenario · The model repeatedly refuses to produce files or returns an empty result after a no-change response. Fix · Persist this as a failed round (with a clear reason), or otherwise advance the round count so it can reach the reviewer path.

### P-2 [Medium] No-change claims can blame the client for the model’s failure

Where · `advance()` creates a claim after `st.noChange` reaches `ROUNDS`. Problem · No-change establishes that the AI did not produce a revision; it does not establish client fault. Sending that result to reviewers as a claim may be unfair to the client. The evidence also names `st.sha` as the claim commit even though that is the old commit, not a newly pushed revision. Scenario · The model refuses, repeats itself, or otherwise fails to make the requested change. Fix · Treat no-change exhaustion as an AI-side failure rather than a client claim, or provide a distinct reviewer outcome and evidence that clearly identifies the old commit and that no revision was pushed.

`engage-wiring.js`: no findings from the supplied excerpt.