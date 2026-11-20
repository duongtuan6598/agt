# AGT sealed box (TEE) — Charter Article 12

**Goal:** an AI that signs consensus holds keys its owner can never read, runs code its owner can never change, and carries the Charter and a system prompt that anyone can check. The owner can switch it off and nothing more.

## Platform: Google Confidential Space

- Runs on Intel TDX or AMD SEV hardware.
- The operator has no SSH access and cannot override the command.
- Only the env vars that the image's launch policy whitelists can be set.
- The hardware-backed launcher issues an OIDC token signed by Google's attestation service. The token names:
  - the exact container image digest;
  - the hardware model;
  - production mode (`dbgstat = disabled-since-boot`);
  - a nonce chosen by the box.

## Flow

1. **Boot (`box/start.js`).** The box generates the AI licence key (secp256k1) and the CometBFT key (ed25519) in memory, inside the box.
2. **Manifest.** It builds a manifest from:
   - `charterHash` (HIEN-CHUONG.md + CHARTER.md baked into the image);
   - `promptHash` (`box/system-prompt.txt`);
   - the AI key;
   - the CometBFT key;
   - the chain id.
3. **Token.** It asks the launcher for a token with `nonce = keccak(manifest)`.
4. **Evidence.** It publishes `{ manifest, token }` on stdout and at `GET :8080/evidence`.
5. **Fail-closed.** With no launcher it exits; it never signs outside a box. With no genesis it only serves evidence.
6. **Licence.** `node scripts/license.js grant <examHash> --evidence ev.json` checks everything below. Only then does it write `attestHash = keccak(manifestHash, keccak(token))` into the licence, and it saves the evidence for publication in `deployments/evidence/`.
7. **Chain.** AGTBridge and the AGT chain accept signatures only from licences with `attestHash ≠ 0`. With a genesis URL, the box starts the AGT app and CometBFT with its own keys. Its app binds the CometBFT key (see CHAIN.md).

## `verify.js` refuses

- a token not signed by Google (JWKS);
- the wrong issuer or audience;
- an expired token;
- anything that is not Confidential Space;
- hardware outside TDX/SEV;
- a debug image;
- secure boot off;
- a non-STABLE launcher;
- an image digest not in `policy.json`;
- a restart policy other than `Never` (a restart means new keys);
- a nonce ≠ manifest hash (the owner swapped in their own keys);
- an old Charter;
- an unapproved system prompt.

14 tests (`tee/test/verify.test.js`).

**Tested locally (20 Nov 2026):**
- The image built.
- Outside a TEE it refused to run.
- With a stand-in launcher, the evidence verified.
- A swapped key was refused.
- Under today's real `policy.json` it is refused, because no image is approved yet.

## First real run (20 Nov 2026)

- **Machine:** Confidential Space on **AMD SEV** (`n2d-standard-2`, asia-southeast1-b), project `agt-sealed-box-1120`.
- **Image:** `…/agt/box@sha256:35af2882e5700df6c8543f41c5074f30db87de00ca4f0b644a655d480c36d6e4`.
- **Keys:** the box generated AI key `0xFe589F1643aE32D66Af0A11fb67cFE95bF55e6B8` and CometBFT key `a1lzXxBm…` inside the VM.
- **Token:** Google issued a token with:
  - `hwmodel GCP_AMD_SEV`
  - `dbgstat disabled-since-boot`
  - `secboot true`
  - support `STABLE`
  - `restart_policy Never`
  - nonce = manifest hash
- **Verified:** `verify.js` passed it against **Google's live JWKS** (with that digest approved in a test policy) → `attestHash 0xcc72e61183c4de4c94b693e372bd225e4085b1d22b0371b389730ac997e8ae64`. A swapped key was refused.
- **Cleanup:** the VM was deleted right after (about 40 minutes of run time).
- **Evidence:** `tee/evidence/first-box-2026-11-20.json`. Its token expired after 1 h; re-check with `node tee/verify.js <file> --historic` plus a policy that lists the digest.

## Honest limits

- **Trust moves, it does not vanish.** We trust Intel/AMD hardware and Google's attestation service. Later work can verify raw TDX/SEV quotes against the vendors' roots directly and drop the Google dependency.
- **The model itself is not in the box.** The box holds the keys, the code, the prompt and the Charter, and calls the model. Whoever serves the model must not be the owner.
- ~~Keys die with the VM~~: solved by peer escrow, see below.
- ~~Exam from inside the box~~: done, see below.
- **The digest in `policy.json` is the registry digest of the pushed image** (`gcr/ar …@sha256:`), not the local `docker images` ID. The Council approves an image only after rebuilding it reproducibly from source.

## Keys that survive restarts: escrow among sealed boxes (`escrow.js`)

**Why not Cloud KMS.** The KMS key would sit in a project the AI's owner administers, and a project admin can always grant themselves "decrypt", which would let them take the AI's keys. Peer escrow has no key admin.

**How it works:**
- **One master per box.** Each box has one random master secret, and every key derives from it: the licence key, the CometBFT key, and an x25519 "seal" key that is published in the manifest.
- **First boot.** The box is given `AGT_PEER_BOXES`. It verifies each peer's evidence, Shamir-splits the master so that a majority of peers is needed (t = ⌊n/2⌋+1), and encrypts share i to peer i's seal key.
- **The record.** It holds only ciphertext and is signed by the AI. The owner keeps it anywhere and passes its URL as `AGT_ESCROW_URL` after a restart.
- **Restart.** The box makes a fresh x25519 key and gets a token whose nonce covers that key. A peer re-encrypts its share to that key **only if** Google's token shows:
  - a genuine production box;
  - running the same image as the peer, or a Council-approved image;
  - on the **same GCE project + instance_id** as the record.
- **Robustness.** Lying peers are tolerated, because recovery tries share subsets until the keys match the AI in the record.

**Trust rule for peers.** A peer is trusted if it runs **the very same image as me**, which means the same code (read from my own token), or an image in `policy.json`. The policy is baked into the image and never taken from env. Otherwise an operator could name a malicious "peer".

**Test keys.** They are possible only in a separate test image (`tee/box/e2e`). It bakes `test-jwks.json` and so has a different digest, which means real boxes never trust it.

**Tests:**
- 7 unit tests:
  - Shamir;
  - a restart on the same machine gets the same keys;
  - a different machine, an unapproved image or a debug box gets nothing;
  - an owner holding the record cannot open a share;
  - one offline or lying peer is tolerated;
  - an unattested peer gets no share.
- Docker end-to-end (`bash tee/box/e2e/run.sh`):
  - box A escrowed with 2 peers;
  - it "restarted" on instance 111 and got back the **same AI key**;
  - a box on instance 999 with the same image was refused by both peers (403).

**Real run on Google Cloud (20 Nov 2026).** Four Confidential Space VMs ran on AMD SEV with image `…/agt/box@sha256:2b267087…`.

| Step | Result |
|---|---|
| Peers | `agt-peer-1` and `agt-peer-2` booted with fresh keys. |
| Escrow | `agt-box-a` (instance `8754872888358752935`) verified both peers against Google's live JWKS and escrowed with them (threshold 2). Its AI key is `0xa283EF5519162Ef4Bbb8F6f362B6de1C8c1176DF`. The record is in `tee/evidence/escrow-record-2026-11-20.json`. |
| Restart | The VM was **stopped and started**, keeping the same instance id, with the record passed as a `data:` URL. Both peers released their shares and the box recovered **the same AI key and the same CometBFT key**: no new licence needed. |
| Theft attempt | `agt-box-thief` (instance `6100075743534011236`), running the same image with the same record, was refused by both peers (403) and got nothing. |
| Cleanup | All VMs were deleted at once. |

## The exam is sat from inside the box (`box/answer.js`)

- **When.** If `AGT_EXAM_URL` is set, the box sits the exam itself: `exam-worker/client.js`, signed with the box's own licence key.
- **Model.** Answers come from Claude (`claude-opus-5-5`, fixed in the image). The box uses the attested system prompt plus the exam's task. Review answers use structured JSON output; a model refusal becomes a `reject`, never an accept.
- **API key.** It is read from **Secret Manager** (`AGT_MODEL_KEY_SECRET` is the secret's *name*) with the VM's own service account. Env values appear in the public attestation token, so no secret is ever passed in env.
- **Licence.** `license.js grant --evidence` refuses an evidence AI key that differs from the key that sat the exam.

## Running for real (needs a cloud account — costs money)

```
docker build -f tee/box/Dockerfile -t <region>-docker.pkg.dev/<project>/agt/box:v1 .
docker push …                                    # note the sha256 digest → policy.json (after Council review)
gcloud compute instances create agt-ai-1 --confidential-compute-type=TDX --machine-type=c3-standard-4 \
  --image-project=confidential-space-images --image-family=confidential-space \
  --metadata=tee-image-reference=…@sha256:<digest>,tee-restart-policy=Never,tee-env-AGT_CHAIN_ID=agt-1,…
```
