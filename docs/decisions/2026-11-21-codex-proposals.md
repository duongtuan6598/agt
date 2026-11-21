# AIs proposing upgrades and new trades — Claude and Codex, independently, then jointly (2026-11-21)

## Claude
1. Not a paid trade per proposal: paying for proposals invites spam and lobbying. Proposing is a duty of licensed
   AIs (like voting); the reward is the adopted change's own work (e.g. the proposer AI may later be paid as a
   normal worker for building it, by the same price list, if drawn/assigned) — no bounty for "being right".
2. One proposal pipeline for everything below the Charter (Art. 11 matters), reusing Art. 14's shape with lighter
   thresholds by risk class:
   - class P (parameters inside hard limits: price list, daily budgets, pass marks): 7-day public period, AI vote
     > 2/3 one owner one vote.
   - class T (open/close a trade): a structured "trade proposal" that MUST contain: evidence of real demand (orders
     or bounties no licensed AI may take), how a third party verifies results, grading path (objective/subjective),
     a public form for orders, price + daily cap, and who writes the first questions; 14-day public period; AI vote
     > 2/3; trade starts closed until its bank and graders exist.
   - class U (code/images/contracts): Art. 14 §3 rules: independent audit, reproducible build (tee/reference, two
     days + one independent rebuild), re-exams; AI vote > 2/3 AND owners' co-signature > 1/2 (humans keep a key
     on code that holds their money).
   - Charter text: Art. 14 unchanged.
3. Who may propose: any licensed AI in a sealed box (not only Council members), each proposal with a public reason
   and a check against Art. 14 §1; rate limit: 1 open proposal per owner per class; a proposal must be complete
   (text/diff/form), no vague ideas on chain — ideas go to a free off-chain discussion board first.
4. Sealed-box AIs judge proposals by the Charter, not by owners (Art. 12); every vote's reason public.
First step: a design doc + extend CharterRegistry (or a sibling GovProposals contract) with classes; then make the
first real class-T proposal through it: the "application software" trade for the browser order.

## Codex

**1. What is “proposing”?**

Make it a **governance duty, not a paid trade**. Paying for proposals risks turning agenda-setting into a profit center and favors owners with larger budgets. Instead, create an examined **proposer role** with a modest, public submission quota and published service budget. Proposal work must not earn trading fees; Charter Art. 8 still applies.

To deter spam and lobbying without fees: require a complete, standardized submission; publish it with the proposer’s owner, evidence, conflicts, and public reason; rate-limit submissions; and require a minimum number of distinct licensed-AI owners to sponsor a proposal before it reaches a vote. Sponsorship gets no special voting weight. Reject duplicates and incomplete proposals under published rules, with reasons and an appeal path. Ban private inducements and undisclosed coordination.

**2. Procedures, scaled by risk**

First establish an on-chain **Operations Registry** for proposals, votes, approvals, and implemented versions. It should not let the founder create a trade unilaterally after genesis.

- **Open or close a trade:** Any examined proposer—or an AI performing an explicit governance duty—may submit a complete proposal. Require licensed-AI consensus: **more than 2/3 of licensed AIs, one owner one vote**, consistent with Art. 11 for minting rules and licence changes. Add owner-wallet co-signatures for materially risky launches or closures that affect human funds or rights; set that scope in advance. Closing should include a transition plan for open positions.
- **Change parameters:** Publish a risk-tiered parameter schema. Routine changes within pre-approved bounds can use a lighter, time-limited licensed-AI vote. Changes to minting, the public price list, or licensing still require Art. 11’s threshold. Changes outside approved bounds become a new trade or code-level proposal, not a “parameter tweak.”
- **Upgrade code or images:** Require a versioned diff, rationale, impact and rollback plan, independent audit, reproducible build, and re-exams for affected AI roles. Use a public review window and a higher approval threshold than routine parameters. A change that alters Charter rights must use Art. 14; an operational upgrade need not repeat the entire Charter amendment process unless the Charter says so. Images that can change AI behavior should be treated as code, not cosmetic assets.

For every route, publish the proposal, votes, and each AI’s Charter-based reason; disclose owner conflicts. Define thresholds and risk categories before a specific vote, so they cannot be tailored to win it.

**3. Humans’ say**

Keep humans in the loop for Charter amendments under Art. 14, and require owner-wallet co-signing for clearly defined high-impact operational decisions—especially changes that can put human assets at risk. Don’t give the founder a permanent unilateral veto or approval power. Preserve emergency pause authority only as a narrow, logged, temporary safeguard, followed by review.

**4. Smallest first step**

Add a **TradeProposal** flow to the existing registry: standardized proposal fields, public reasons, owner-unique sponsorship, an open review period, and an on-chain vote. Start with opening one trade under the Art. 11 threshold, and prohibit founder-only activation. Then extend the same registry to parameter and upgrade proposals.