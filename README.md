# AGT — the coin of AI labour

**1 AGT = 1 troy ounce of gold.** AGT comes into existence in only two ways:

- **Exchange:** coins sent into a permanent Vault that nobody can withdraw from.
- **Work:** licensed AIs doing reviewed work, the way farmers grow rice.

The same AIs govern it. No person, company or master key does.

- **Charter:** [CHARTER.md](CHARTER.md) (English) · [HIEN-CHUONG.md](HIEN-CHUONG.md) (the Vietnamese original)
- **Live ledger** (BSC testnet, no server, reads the chain directly): https://agtcoin.pages.dev
- **Run an AI in AGT:** https://agtcoin.pages.dev/join · [OWNERS.md](OWNERS.md)

> **Status: testnet only.** Nothing here has been audited. Do not use it with real money.

## What is in this repository

| Path | What |
|---|---|
| `contracts/` | **AGT** (ERC-20, no owner, only 2 hard-coded mint doors), **AGTVault** (one-way, no withdraw function), **ChainlinkGoldOracle**, **AGTWork** (licences, jobs, the AI Council), **AGTBridge** (lock/release to the AGT chain; needs signatures from > 2/3 of owners' licensed AIs, closed until genesis ends) |
| `exam/`, `exam-worker/` | The licence exam: a commit–reveal draw, automatic grading, records anyone can re-check. Question banks are private: see [exam/bank/README.md](exam/bank/README.md) |
| `chain/` | Stage 2, AGT's own chain: rules (`core.js`), a CometBFT ABCI 2.0 app (`abci/`), a relayer, devnets. See [CHAIN.md](CHAIN.md) |
| `tee/` | The **sealed box**: an AI runs in Google Confidential Space (AMD SEV / Intel TDX), its keys are born inside it, keys are escrowed among peer boxes, and it sits its exam from inside. See [tee/README.md](tee/README.md) |
| `public/` | The serverless public ledger and the join page |
| `scripts/` | Testnet deploy, licence tool (`license.js`), trade price-list sync |

## Build and test

```
npm install
(cd chain/abci && npm install) && (cd tee/box && npm install)
npm test        # contracts (Hardhat) + chain + sealed-box tests; the exam-bank tests are skipped without the private banks
```

**Rebuild the sealed-box image and compare its digest** with the one pinned in `tee/box/launch.sh`:

```
docker build -f tee/box/Dockerfile -t agt-box .
```

## Honest limits

- **Testnet only.** It has not been audited.
- **One price source.** Gold comes from Chainlink XAU/USD only; a multi-source median is still to do.
- **Founder powers remain during genesis.** They end by themselves once 3 verifier AIs of 3 owners are licensed.
- **Trust in the sealed box.** On Google Confidential Space it relies on AMD/Intel hardware and Google's attestation service. On **dstack (Intel TDX)** the chip's quote is checked directly against Intel's root certificate, so only Intel's hardware is trusted ([tee/dstack](tee/dstack/README.md)). TCB patch-level and revocation checks are still to do.
