# What next — Claude and Codex, independently, then jointly (2026-11-21)

Both answered without seeing the other. Verbatim below, then the joint decision.

## Claude
1. Reproducible, pinned builds of the three images (AI box, embedded box, builder) + a public "how to verify this
   digest" recipe. Nothing can be approved honestly into policy.json without it; every later real run depends on it.
2. Encrypted off-site backup of the private question bank (agt-banks): local-only today = one disk failure loses the
   whole exam. Cheap, irreversible-loss risk. Needs the owner to choose where (encrypted, never public).
3. Persistent, sealed AI memory across VM replacement (escrowed key via the existing peer/escrow recovery), because
   long-term maintenance engagements are the product and a replaced VM currently forgets the client.
4. Full testnet rehearsal end to end (a real AI owner passes trade 6, an engagement with a toy repo, a dispute, a
   builder run) — only after 1–3, with the owner's approval for cost.
Defer: S-2/G-3 extra isolation (§12 means client code does not run in the AI box), lending (owner said no).

## Codex

1. **Protect the private exam bank.** It is unique, local-only, and unbacked-up; losing it could undermine the exam service and its future credibility. First, make and restore-test an encrypted off-site backup, with access and recovery limited to named peers. **Owner decision/money:** approve the backup location, key custodians, and any storage cost.

2. **Prove reproducible builds before approving images.** Without this, neither the embedded box nor the builder can be independently trusted, and a real deployment would turn local images into an unverified trust anchor. First, document one clean rebuild and compare its output to the candidate image; do not add either image to an approval list until the result is independently checkable. **Owner decision:** explicitly approve each image after reviewing the evidence.

3. **Run one testnet rehearsal with a real AI owner and client.** This tests the whole bargain—not just contracts—including exam completion, accepted work, client-controlled N1–N4, disputes, and claim completion. First, write a single end-to-end scenario with clear success/failure criteria, then rehearse it without mainnet funds. **Owner decision/money:** choose participants and approve any cloud or builder-job costs.

4. **Settle builder-job operations before relying on §14.** An empty approval list and launcher cost gate are appropriate safeguards, but nobody yet knows who initiates or pays for jobs. First, propose a transparent default workflow that identifies the requester, payer, approval, and published evidence for each job. **Owner decision:** choose the workflow and who bears costs; don’t silently add a protocol fee or fund.

5. **Publish owner/client operating docs, then use them in the rehearsal.** Clear expectations reduce disputes and let outsiders verify the process. Start with a short guide covering evidence, acceptance, revisions, disputes, privacy, and recovery; update it based on rehearsal failures.

**Must wait:** mainnet deployment should wait for reproducible approved images, a successful rehearsal, and the human owner’s explicit readiness decision. Gold custody, redemption/reserve verification, legal treatment, and an independent security review also need explicit answers before representing the 1 AGT = 1 oz claim as dependable in practice.

**Stop:** don’t launch unapproved images, run paid builder jobs without explicit cost approval, or treat passing contract tests as proof of end-to-end readiness.
## Joint decision

Both put the same three items at the top: back up the bank, reproducible builds, a real rehearsal.

1. **Encrypted off-site backup of the private bank, with a restore test** (Codex first; Claude agrees). It is the
   only loss that cannot be undone, and it is the cheapest item. The owner chooses the location and holds the key.
2. **Reproducible builds of the three images**, plus a public recipe for checking a digest. No image goes on an
   approval list until an independent rebuild matches it.
3. **Persistent sealed memory for the AI** (Claude's item; Codex did not list it). It goes in before the rehearsal,
   because a maintenance engagement that forgets the client when its VM is replaced is not the product. It reuses the
   existing escrowed-key recovery.
4. **One testnet rehearsal with a real AI owner and a real client**, with success criteria written beforehand. The
   owner and client guides (Codex's item 5) are written first and corrected by what the rehearsal shows.

**Builder jobs** (Codex item 4) are already settled by §14–§15: whoever wants the evidence runs the job and pays,
only a party to the dispute runs it, and there is no fee and no fund. What is left is to write this into the guides.

**Mainnet must wait** for approved reproducible images, a successful rehearsal, an independent security review, and
public answers on the gold custody and reserve proof behind "1 AGT = 1 oz". This is Codex's flag and both accept it.

**Stop:** treating passing tests as end-to-end readiness; launching unapproved images; any paid run without the
owner's explicit approval.
