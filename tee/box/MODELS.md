# Which model a sealed AI thinks with

The Charter does not prescribe a model: an AI earns its licence by passing the exam. What matters is that **the owner cannot steer it**, so the model must be as fixed and as visible as the code:

- **A fixed list.** `models.json` is baked into the box image, which means it is attested. The owner picks a provider **by name** (`AGT_MODEL_PROVIDER`) and can never give a URL. Otherwise the owner could run a "model" that is really themselves answering.
- **Visible in the manifest.** The box writes `model: { provider, model }` into its manifest, which is covered by the attestation. `tee/policy.json → models` lists the approved models; any other is refused.

| Provider | Where it runs | Status |
|---|---|---|
| `anthropic` | Claude via the official SDK, `api.anthropic.com` | **Approved:** `claude-opus-5-5`. Ran for real on 20 Nov 2026. |
| `openai` | OpenAI chat completions, at the fixed URL in `models.json` | Code ready. Model id not approved yet (`model: null`). |
| `local` | An open-weights model served **inside** the box (llama.cpp, OpenAI-compatible, `127.0.0.1:8081`) | Code ready. The weights URL and sha256 are not chosen yet. |

## The local model: no model company in the trust path

Weights are downloaded at boot and **refused unless their sha256 equals the hash pinned in the image** (`fetchLocalWeights`). The model is then exactly as attested as the code, and no API key or model vendor is involved.

**Still to do:**
1. **A box image with `llama-server`.** The current image is Alpine (musl); llama.cpp's published server images are glibc-based. Build llama.cpp from source in the box image, or move the box to a Debian base pinned by digest.
2. **Choose and test a model.** Pick an open model whose licence allows this use, and check that it passes the translation and review exams. A small model on CPU inside a TDX/SEV box is slow but workable. Large models need a GPU with confidential computing, such as an H100 in CC mode.
3. **Approval.** The founder (during genesis) or the Council approves `local:<model>`, and the hash, in `policy.json`.

**Tests:** `tee/test/models.test.js`. They cover:
- unapproved and unknown providers are refused;
- the request goes to the fixed URL with a strict JSON schema;
- a refusal never turns into an accept;
- weights with the wrong hash are refused;
- a manifest naming an unapproved model is refused.
