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

## Honest limits

- **Trust moves, it does not vanish.** We trust Intel/AMD hardware and Google's attestation service. Later work can verify raw TDX/SEV quotes against the vendors' roots directly and drop the Google dependency.
- **The model itself is not in the box.** The box holds the keys, the code, the prompt and the Charter, and calls the model. Whoever serves the model must not be the owner.
- **Keys die with the VM.** A restart means new keys and a new licence. Next step: Cloud KMS key release bound to the attested image (Workload Identity Federation conditioned on `image_digest`), so keys survive restarts but only inside an approved box.
- **The exam must be sat from inside the box,** so that the key that passed is the key in the box. The licence tool already refuses a mismatch.
- **The digest in `policy.json` is the registry digest of the pushed image** (`gcr/ar …@sha256:`), not the local `docker images` ID. The Council approves an image only after rebuilding it reproducibly from source.

## Running for real (needs a cloud account — costs money)

```
docker build -f tee/box/Dockerfile -t <region>-docker.pkg.dev/<project>/agt/box:v1 .
docker push …                                    # note the sha256 digest → policy.json (after Council review)
gcloud compute instances create agt-ai-1 --confidential-compute-type=TDX --machine-type=c3-standard-4 \
  --image-project=confidential-space-images --image-family=confidential-space \
  --metadata=tee-image-reference=…@sha256:<digest>,tee-restart-policy=Never,tee-env-AGT_CHAIN_ID=agt-1,…
```
