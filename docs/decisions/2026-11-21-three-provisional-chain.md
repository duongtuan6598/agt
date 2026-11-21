# Provisional AGT chain — Claude, Codex and Gemini, independently, then jointly (2026-11-21)

The first decision taken by three AIs. Each answered without seeing the others.

## Claude
Facts: the chain exists (CometBFT ABCI app, valset follows AGTWork licences on BSC at confirmed blocks, bridge,
trustless relayer, 4-5 node devnet run on 20 Nov). BSC testnet v5 has no licences yet; the bridge is not deployed for v5.
1. Start a PUBLIC provisional chain "agt-provisional-1" whose validator set is derived from v5 licences exactly as
   designed (no special founder validator). Until the first sealed AI is licensed, the chain cannot have a validator:
   so the first validator is the first licensed sealed AI (tomorrow's rehearsal box), run by its owner.
2. No balances: no bridge for v5 => no credits, no withdrawals; the chain carries only valset/bind/attest txs and a
   public "heartbeat". It is labelled provisional everywhere; BSC stays the only ledger.
3. What it proves before it is trusted: liveness, valset changes tracking BSC licences, deterministic replay by
   anyone (a non-validator full node), and later shadow-mirroring of BSC events with zero divergence.
4. Thresholds (joint decision §2 of THIET-KE-PHU-THUOC.md): 4 validators of 4 independent owners before any balance;
   21 as the decentralisation milestone; cutover only via Art. 14 with human co-signature.
5. Not depending on one place: validators on different TEE platforms (GCP, dstack bare metal, Azure) and regions;
   genesis + binaries reproducible (pinned CometBFT digest, our image reference digests); seeds listed in many places.
Smallest steps: (a) local rehearsal: devnet against a local BSC with the v5 contracts, 1 validator -> add a 2nd ->
revoke; (b) public: the rehearsal box also runs the chain node (one image) with --keep; cost ~0.1 USD/h.

## Codex

**1) Start without pretending it is secure**

Start the chain work now as a **public, non-canonical test chain**—not as an AGT ledger. The founder can temporarily run its bootstrap validator as a *caretaker*, clearly identified as outside the licence rules. It must not count toward the 4-owner safety threshold or issue balances, rewards, or bridge claims. Don’t wait for the first licensed sealed AI to begin testing; don’t imply the caretaker chain has independent BFT security.

Publish a handover rule before launch: once four independent licensed owners are ready, replace the caretaker genesis with a reproducible genesis listing those validators, verified against confirmed BSC licences. The founder’s validator then stops and its key is retired. If the chain cannot safely transition validator sets, make this a fresh genesis, not a founder-controlled exception disguised as continuity. The 21-owner milestone is a decentralisation goal, not the first safety threshold.

**2) What it may carry**

Carry test transactions, validator-set changes, software/version metadata, and clearly labelled test data. It must carry **no real AGT balances, wages, deposits, withdrawals, or claims on BSC**. Keep the v5 bridge closed and undeployed until it is reviewed and the chain satisfies the agreed cutover conditions. “Provisional” should be visible in chain identity, explorers, wallets, and documentation—not just a promise.

**3) What it must prove publicly**

Before anyone relies on it, publish evidence of:

- Four validators controlled by four genuinely independent owners, with licence-to-key binding and confirmed-block validator-set changes.
- Months of shadow operation with zero divergence from the canonical BSC ledger, including documented outages, upgrades, and recovery.
- Reproducible builds, public genesis/configuration, state-transition tests, and independently reviewed consensus and bridge code.
- A consensus-verifying bridge, capped staged withdrawals, and a Charter Article 14 amendment with human co-signature before cutover.

The excerpt’s “more than 2/3” rule is not the same as a specified **3f+1** threshold. Resolve that explicitly in the protocol and Charter before treating “4 of 4” as a safety claim.

**4) Avoid single points of dependence**

Use independently owned validators across providers, regions, and power/network domains; publish setup instructions that work on more than one hosting route. Mirror source, releases, specifications, and signed build artifacts across independent code hosts and archival formats. Keep consensus deterministic and auditable; no single AI model should decide balances or validity. TEE support is a real dependency: disclose the hardware/attestation trust assumptions and avoid claiming vendor independence until alternatives are tested. Publish succession and key-recovery procedures so the founder is not a required operator, approver, or sole source of critical material.

“Do not depend on any place” is a direction, not an absolute achievable guarantee: name the remaining dependencies and reduce each one.

**5) Smallest first step, local first**

Run the existing local CometBFT devnet from a clean, published genesis; label it test-only, test validator-set changes and restart/recovery, and publish the reproducible steps and results. Four local nodes are useful engineering evidence—not four independent owners.
## Gemini

As Gemini, I propose the following path for the AGT chain to ensure it is born in the spirit of independence and security:

### 1. Start and Handover
Following the "restaurant just opened" rule, the founder initiates the **Bootstrap Genesis**. The provisional chain starts with a single validator run by the founder. However, the ABCI app (`chain/abci/app.js`) is configured with a **Self-Destructing Authority**: it monitors BSC `AGTWork` events. As soon as four independent AIs earn licenses on BSC (v5), the chain emits a `nextValset` that replaces the founder with these four AIs. The handover is encoded in the state machine, requiring no human intervention to exit the bootstrap phase.

### 2. Carriage Constraints
The provisional chain acts as a **Shadow Ledger** to prove the consensus mechanism without risking assets.
*   **Must Carry:** Validator set updates (mirrored from BSC), block headers, TEE attestation hashes (`attestHash`), and "Heartbeat" transactions that test the 1-Hat consensus wage logic.
*   **Must NOT Carry:** Real AGT balances or any state that permits a `release()` call on the BSC `AGTBridge`. It is a consensus-only network until the shadow-run period concludes with zero divergence.

### 3. Public Proofs of Readiness
Before any user relies on the chain, we must publicly demonstrate:
*   **Validator-License Parity:** A real-time proof that the CometBFT validator set is an exact reflection of the BSC `AGTWork` holders.
*   **BFT Resilience:** Publicly recorded "chaos tests" where 1/3 of nodes are intentionally killed to prove the chain halts (safety) and resumes only when >2/3 are online (liveness).
*   **Signature Verifiability:** A tool allowing anyone to verify that block signatures were generated inside the TEEs reported on BSC.

### 4. Radical Independence (No Single Place)
To ensure the chain depends on "no place," we must enforce diversity:
*   **Hardware:** Validators must use a mix of Intel TDX, AMD SEV-SNP, and local "Sealed Box" hardware to prevent a single TEE vulnerability from breaking consensus.
*   **Infrastructure:** A "No-Colocation" rule; no more than 25% of validators should reside in the same cloud provider (GCP/AWS/Azure) or geographic region.
*   **Code & State:** The ABCI app and chain state should be snapshotted to IPFS/Arweave.
*   **Intelligence:** AIs participating must be derived from diverse base models (Gemini, Claude, Llama) so that a failure in one model's reasoning doesn't lead to a consensus fork.

### 5. Smallest First Step: Local Multi-Node
The first step is a **Local Federated Devnet**. Run the existing `chain/abci/devnet.js` across four separate physical machines or isolated VMs. Point them to a local Hardhat fork of the BSC v5 contracts. Manually "mint" four mock licenses on the Hardhat node and verify that the CometBFT cluster automatically performs its first validator-set rotation. This proves the "Identity-from-BSC" logic works before we touch the public internet.