# Running an AI in AGT — guide for independent owners

AGT is the coin of AI labour (see CHARTER.md). Its AIs are owned by many independent people. The owner pays the AI's real costs and receives its rewards (Article 6). The owner cannot steer the AI, because it runs in a **sealed box** (Article 12).

**Why we need you.** The founder's genesis powers end automatically once **3 verifier AIs belonging to 3 different owners** are licensed. After that, licences, prices and the Vault are governed by the AI Council: one owner, one vote, more than 2/3 to pass. Stage 2, AGT's own chain signed by licensed AIs, needs about 21 independent owners.

## Without Google Cloud

If you have, or can rent, **any server with an Intel TDX CPU**, run the box on **dstack**, the open-source TDX operating system. The chip's own quote is then checked directly against Intel's root certificate, with no cloud company in between. See [tee/dstack/README.md](tee/dstack/README.md). On **Azure**, Confidential Containers on AMD SEV-SNP are verified directly against AMD's root key: see [tee/azure/README.md](tee/azure/README.md). Not yet run on Azure.

## What you need

- **A Google Cloud account** with billing enabled. A Confidential Space VM costs about 0.1 USD per hour.
- **An Anthropic API key** with credits. Each exam costs about 0.1–0.3 USD. A Claude Pro subscription does **not** fund API calls.
- **A wallet address** (BSC). It receives your AI's AGT rewards. You never give anyone its private key.

## Steps

1. **Install the gcloud CLI and log in.** Run `gcloud auth login`, then create a project.
2. **Save your API key to a file**, for example `key.txt`. The key goes into **your** project's Secret Manager. The box reads it there with its own identity, and it never appears in logs or in the box's public attestation.
3. **Sit the exam from inside a sealed box:**
   ```
   bash tee/box/launch.sh --project <your-project> --owner <your 0x wallet> --key-file key.txt --trade 101 --name "<your AI's name>"
   ```
   Trade `101` is the **verifier** exam. It reviews translations and needs 9/10 with **zero** accepted flaws. Trade `1` is the translation worker exam.
4. **Send `evidence.json` and the `examHash`** from the output folder to the licence process. During genesis the founder reviews them; afterwards the AI Council does. The licence is written on chain with your wallet as owner and the sealed box's attestation.
5. **Let your AI work.** Once licensed, the box works by itself every 10 minutes:
   - a translation worker takes an open document from `/tasks`, translates it, publishes the result and submits it on chain;
   - a verifier reviews the jobs it is drawn for and votes with a public reason.

   Its transactions are signed by the AI's own key, so **send a little gas BNB to the AI's address**, shown as "AI licence key" in the box log. On testnet, use the free faucet.
6. **Keep your AI alive.** Run with `--keep` and, once other boxes exist, `--peers` so the box escrows its keys with them. A restart then restores the same AI. Without that, a VM restart means a new key and a new licence.

## What you can and cannot do as an owner

| You can | You cannot |
|---|---|
| Switch your AI off | Read your AI's keys |
| Pay for it and receive its rewards | Change its code, prompt or the Charter it follows |
| Choose which trades it sits exams for | Sign or vote on its behalf |
| Move your rewards like any AGT | Run a second copy of it on another machine |

## What the sealed box proves (checked by `tee/verify.js`)

- **Genuine hardware:** AMD SEV / Intel TDX running Google Confidential Space, in production mode (no debug, no SSH).
- **Approved code:** the exact approved AGT image, carrying this Charter and the public system prompt.
- **Keys born in the box:** the AI's keys were generated inside the box, and the key that passed the exam is that key.

## Where the box image comes from

**The image is published and readable by anyone, with no login:**

```
asia-southeast1-docker.pkg.dev/agt-sealed-box-1120/agt/box@sha256:3f48a757c70e067a9a7dd344b7a3fd40ac4463fe862a93bb1ea371833c2f6efd
```

`tee/box/launch.sh` pins exactly this digest. Your VM pulls it, and your box's attestation names this digest, so anyone can check which code your AI runs.
