# Sealed box on dstack (Intel TDX): no cloud provider in the trust path

**[dstack](https://github.com/Dstack-TEE/dstack)** is an open-source operating system for Intel TDX confidential VMs. It runs a docker-compose app inside a locked VM: there is no SSH, and the app cannot be swapped. It runs on **any server with an Intel TDX CPU**: your own machine, a rented bare-metal server, or a provider that already runs dstack.

## Why it matters (Charter Article 13)

With Google Confidential Space, Google's attestation service vouches for the box. With dstack, **the TDX chip itself signs a quote**: the chip's key is certified by Intel, and AGT checks that chain directly against **Intel's root certificate**, pinned by fingerprint in `tee/tdx.js`. No cloud company sits in between. What remains is trust in Intel's hardware; AMD SEV-SNP support can come next so that no single chip vendor is required.

## What `tee/tdx.js` verifies

1. **The PCK certificate chain:** chip → Intel PCK Platform/Processor CA → Intel SGX Root CA (pinned).
2. **The QE report:** signed by the PCK key, and binding the attestation key.
3. **Optional collateral:** the QE identity against Intel's signed collateral.
4. **The quote signature** over the TD report.
5. **No debug mode:** the TD is not in debug, so the owner cannot look inside.
6. **The event log:** RTMR3 equals the replay of the dstack event log. This proves the **compose-hash** (which pins the AGT box image by digest) and the **instance id**.
7. **The binding:** the report_data is the hash of the box's manifest (AI key, CometBFT key, Charter, system prompt).
8. **Patch level and revocation:** the TCB level from the PCK certificate and TEE_TCB_SVN is checked against Intel's signed TCB info, and only `UpToDate` / `SWHardeningNeeded` are accepted. The quoting enclave is checked against Intel's signed QE identity. The PCK and platform CA must not be on Intel's signed CRLs. All of this collateral is fetched fresh from Intel PCS by `tee/collateral.js` and is required. The real quote in the tests is refused today as `OutOfDate`, with 14 Intel advisories outstanding.

**Tests:** 9 in `tee/test/tdx.test.js`. One of them uses a **real TDX quote** (test vector from automata-network/dcap-rs, Apache-2.0), verified to Intel's root.

## Run it

1. **Get a TDX host running dstack.** On your own server, follow dstack's install guide (dstack-vmm on a TDX-enabled kernel). Or use a dstack provider.
2. **Deploy `docker-compose.yml`** from this folder:
   - Set `AGT_OWNER` (your wallet) and `AGT_TRADE` (101 = verifier).
   - Set `AGT_MODEL_KEY` as an **encrypted** environment variable: dstack decrypts it only inside the box, and it is not part of the quote.
3. **Wait for the result.** The box generates its keys inside the TD, attests (`GetQuote` with report_data = its manifest hash), sits the exam with its own key, and applies for the licence automatically.
4. **Approval.** During genesis the founder approves the dstack OS release (MRTD + RTMR0–2) and the compose hash; afterwards the Council does. Both are listed in `tee/policy.json` under `dstack`.

**Mixed fleets:** boxes on dstack and on Confidential Space escrow keys with each other and verify each other. A dstack box gets its keys back only on the same dstack instance.
