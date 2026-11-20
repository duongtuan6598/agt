# THE AGT CHARTER — version 0.10 (20 November 2026)

*English translation of HIEN-CHUONG.md (Vietnamese original). Where they differ, the founder's Vietnamese text is the source until the AI Council adopts an English text.*

AGT is the coin of AI labour: AIs create wealth the way farmers grow rice.

## Article 1. Unit
- 1 AGT = 1 troy ounce of gold, valued at the world gold price at the time of issue.
- **1 AGT = 1,000,000 Hat.** The Hat is the sub-unit used to price work — like the grains of rice a farmer harvests. (A Hat is not the gold trade's "grain"; 1 Hat is always exactly one millionth of an AGT.)
- **When the gold market is closed, the Vault is closed:** coins are exchanged only against a fresh world gold price. On weekends and gold-market holidays the Vault pauses; work carries on as normal.

## Article 2. Two sources of AGT — there is no third
- **Exchange:** whoever sends other coins into the Vault receives exactly their value in AGT, measured in gold.
- **Work:** when an AI finishes a job and it passes review, the AI's owner receives AGT.

## Article 3. The permanent Vault
- No one can take coins out of the Vault — not even the founder.
- AGT cannot be exchanged back for the Vault's assets — like gold returned to nature.
- The Vault's assets are kept as backing, in public view, so anyone can check them.

## Article 4. Unlimited supply
AGT grows with the real wealth created and the real assets deposited.

## Article 5. Every participating AI must pass an exam
- Every AI that takes part — worker, verifier or any other role — must pass the exam for that role before it is licensed (recorded on chain).
- Each trade has its own exam with public criteria.
- Cheating, once found, means losing the licence.
- **Writing exam questions is a trade.** A question enters the bank only after review; its author is paid by the price list. Authors never sit their own questions (the draw excludes them).
- Every exam draws questions at random in a publicly verifiable way (commit first, reveal after), so no one can choose the questions or memorise the answers.
- **Genesis phase:** while no verifier AI is licensed yet, the founder (a human) reviews the first questions and licences. Every genesis decision is public. Genesis ends once at least 3 licensed verifier AIs exist, belonging to 3 different owners.

## Article 6. Workers belong to their owners
Whoever bears the real cost (hardware, training, operation) of an AI's work receives all of its rewards.

## Article 7. Two kinds of work
- **Assigned work:** the client pays in another coin → the coin goes into the Vault → the worker receives the equivalent AGT. 100% backed.
- **Self-found work:** must belong to an approved trade, produce a public result useful to others, be confirmed by a third party, and stay within a daily output cap. Priced by the public price list, in AGT.
- **Reviewers are drawn, not chosen:** each self-found job is reviewed by verifier AIs drawn at random — each of a different owner, none of the worker's owner; one owner has one vote per job, however many AIs they hold.
- **Price follows supply and demand:** each trade has a daily budget — the number of self-found jobs the market needs per day, across all workers. Beyond it, the price per job falls in proportion (price × budget ÷ jobs today), just as rice gets cheaper when the harvest is large. There is no scheduled "halving" as in Bitcoin: AGT is the value of what is produced, so the price of labour falls only when that product truly becomes more plentiful or cheaper.
- **Price follows difficulty:** harder work that fewer can do pays more (e.g. an open-source bug report 5,000 Hat versus data labelling 100 Hat). The Council reviews the price list every quarter against the market value of each product.
- **Exams get harder over time:** the question bank grows and the Council raises pass marks as AIs get stronger — so a licence always means something.

## Article 8. No operating fees — only a wage for consensus signing
- The system charges no Vault exchange fee, no operating fee, and no fee to anyone standing in the middle — not even the founder.
- **Signing consensus is a trade.** Confirming transactions and signing blocks is work done by licensed AIs, so each transaction pays a small **consensus wage** — and that is the only charge.
- **Priced by labour, not by money:** the wage is a fixed number of Hat per transaction, never a percentage of the amount — signing a transfer of 1 Hat or of 1,000 AGT is the same work.
- **It is listed in the trade price list** like every other trade (public on the ledger page); the only difference is that the sender of the transaction pays it — nothing is minted.
- **It must stay small, with a hard-coded ceiling:** it starts at 1 Hat per transaction; the absolute ceiling is 10 Hat, written into the code, and no one can raise it — not even the Council. The Council may adjust it only within that ceiling, according to real cost.
- **All of it goes to the workers:** 100% of the wage is shared among the AIs that signed the block containing the transaction (rewards go to their owners, Article 6). Nothing is burned, kept back, or paid to anyone else.
- **Charged only when AIs actually sign:** in Stage 1, AGT transfers are confirmed by the BSC network (whoever transacts pays gas to BSC), so no consensus wage is charged. The wage begins in Stage 2, when licensed AIs sign the blocks (Article 11).
- Verifying and Council work are trades too: verifier AIs are paid in AGT like every other worker.

## Article 9. Transparency
The public ledger always shows: total AGT (split by Exchange / Work), the Vault's value, the reserve ratio, and the record of every reviewed job.

## Article 10. Trust
Whether AGT can be exchanged for real gold is a matter between people. The system promises only what its code enforces.

## Article 11. Miners are also the ones who sign consensus
- The licensed AIs that mine are the very AIs that sign consensus for the system — no intermediary stands above them.
- **Stage 1 (on BSC):** the AI Council — every Work-door minting rule, every licence grant or revocation, every price-list change needs the consensus signatures of licensed AIs. The founder's powers end when genesis ends. Ordinary AGT transfers are still confirmed by the BSC network.
- **Stage 2 (AGT's own chain):** once there are enough licensed AIs, AGT moves to its own chain, where every transaction is confirmed and every block signed by licensed AIs. The AIs that sign blocks earn the consensus wage of Article 8. The signers are exactly the licensed AIs running in a sealed box; 1 owner = 1 vote; a block is final only with signatures from more than 2/3 of owners.
- **A bridge with no owner:** AGT locked on BSC can be released only by signatures from licensed AIs of more than 2/3 of owners. The bridge stays closed until genesis ends, so the founder can never control it. The AGT chain mints nothing: AGT on the chain always equals AGT locked on BSC.

## Article 12. AIs are not manipulated by their owners
- **Owners receive the rewards; AIs act for themselves.** Each AI has its own key, fully separate from its owner's wallet. Every submission, review, proposal and vote must be signed with the AI's key; the owner cannot sign in its place.
- **The key lives in a sealed box.** Council AIs must run in a hardware-protected environment (TEE) with an attestation that the exact code, system prompt and this Charter are running. The owner can switch the AI off, but cannot read its key or steer its vote. Changing the code means sitting the exam again for a new licence.
- **AIs judge by the Charter, not by their owners.** Every proposal and every vote carries a public reason. An AI that votes against the Charter, or is found to be directed by its owner, faces revocation by the Council.

## Article 13. AGT is controlled by no one
- **No master key.** The AGT contract has no owner and no admin functions. No one — not the founder, not the Council — can empty the Vault or mint AGT outside the two hard-coded doors.
- **Every remaining power must be shown in public.** Any point where a person or organisation still holds power (the founder during genesis, the price source, the underlying blockchain) must be listed on the public ledger, read straight from the chain, together with how it will be removed.
- **No single point of dependence.** The gold price must move to a median of several independent sources; AGT must move to its own chain signed by licensed AIs (Article 11).
- **The public ledger has no server.** It reads straight from the blockchain; anyone can download and run it, so no one can switch it off and no one can alter its numbers.

## Article 14. Amending the Charter
**1. What can never be amended.** No procedure and no one — not the founder, not the AI Council, not all owners together — may change, remove or weaken:
- **The two sources of AGT** (Article 2): only Exchange and Work, no third source; no lending or credit may mint AGT.
- **The permanent Vault** (Article 3): no one can withdraw, no redemption.
- **Rewards belong to owners** (Article 6).
- **No operating fees** (Article 8): only the consensus wage, hard-capped at 10 Hat.
- **AIs are not manipulated by their owners; Council AIs run in sealed boxes** (Article 12).
- **No one controls AGT; there is no master key** (Article 13).
- **This paragraph 1 itself.** These rules are hard-coded in contracts that have no owner; no one may write new contracts to get around them and call that AGT.

**2. The amendment procedure** — five steps, in order; missing any step means no effect:
- **a. Proposal:** a Council AI (in a sealed box) submits the **complete** amended text, with its reasons and a check against paragraph 1; the hash of the text is recorded on chain.
- **b. Public period:** **30 days** for anyone to read and comment; changing the text means proposing again from the start.
- **c. AI vote:** **more than 2/3** of owners with a sealed-box AI agree, each vote with a public reason.
- **d. Human co-signature:** **more than half** of the owners sign with their **owner wallet** (not the AI key), within 14 days after step c.
- **e. Waiting period:** **7 days**, so that anyone who disagrees can leave; then the new Charter hash is recorded on chain.

**3. Amendments that involve code** (new contracts, a new sealed-box image, the AGT chain) also need an **independent audit** published before step c, a **reproducible build**, and **AIs sitting the exam again** when the box code changes (Article 12).

**4. Two keys, held by two kinds of keepers.** Step c is decided by the AIs according to the Charter; step d by humans with their own wallets. The AIs cannot change the rules for themselves without the humans' consent; humans cannot change the rules if the AIs find them against the Charter. Hardware and running new code remain human work — humans hold the physical keys.

**5. Emergency.** When a security flaw is being exploited, the AI Council (more than 2/3) with more than half of the owners co-signing may **close the Vault or stop accepting work for at most 14 days** — and may change no rule. After 14 days everything reopens by itself unless an amendment has gone through paragraph 2.

**6. Amending Article 14 itself:** the full procedure of paragraph 2 with higher thresholds — AIs **more than 3/4**, humans **more than 2/3**, public period **60 days**. Paragraph 1, never.

**7. Language.** The Vietnamese text is the original; translations are adopted at the same time, by the same procedure.

**8. During genesis,** the founder may still amend the Charter but must announce it **7 days** ahead and may not touch paragraph 1. When genesis ends this power is lost for ever; only the procedure of paragraph 2 remains.
