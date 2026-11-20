# Sealed box on Azure Confidential Containers (AMD SEV-SNP)

**Azure Container Instances (ACI)** can run a container group inside an **AMD SEV-SNP** utility VM. The group's **container security policy** says which images may run (pinned by digest), which env vars are allowed, and that nobody may `exec` into a container. The sha256 of that policy is written by the hardware into the report's **HOST_DATA** field.

## How AGT verifies it, without trusting Microsoft's attestation service

We do **not** use Microsoft Azure Attestation (MAA). The box asks the **SKR sidecar** for the **raw SNP report** and the **VCEK ← ASK ← ARK** certificate chain. `tee/snp.js` then checks:

1. **The certificate chain** up to **AMD's root key (ARK)**. Milan and Genoa ARKs are pinned by fingerprint, taken from `kdsintf.amd.com`.
2. **The report signature** (ECDSA P-384) by the chip's VCEK.
3. **No debug:** the guest policy does not allow debugging.
4. **The container policy:** HOST_DATA is an approved one, which pins the AGT box image and forbids exec.
5. **The utility VM:** MEASUREMENT is an approved Microsoft UVM release.
6. **The binding:** report_data = sha256(the box's manifest nonce), so the report belongs to this box's keys.

Together with `tee/tdx.js` (Intel TDX, see `tee/dstack`), AGT now accepts boxes from **two chip vendors**, each checked against the vendor's own root.

**Tests:** 6 in `tee/test/snp.test.js`. They include a **real SEV-SNP report** (test vector from google/go-sev-guest, Apache-2.0), verified to AMD's Milan ARK.

## Status and limits (honest)

- **Not yet run on Azure:** this needs an Azure subscription. Until it has run there, `policy.json → azureAci` stays empty.
- **The model API key:** env values on ACI are part of the security policy, so they are public. The key must therefore come through **Secure Key Release** from Azure Key Vault, which releases it only to this exact policy. That is not implemented yet.
- **The utility VM is Microsoft's.** Its measurement is approved per release. Trust in Microsoft is not fully removed here; for that, use dstack on your own TDX server.
- **Keys survive only on the same chip.** Escrow identifies the box by its `chip_id`. ACI may restart a group on another host, which then needs a new licence.
- **Patch level and revocation:** the VCEK must carry this chip's id and exactly the report's TCB (bootloader / TEE / SNP / microcode). An optional minimum TCB comes from `policy.json → tcb.amdMin`. The ASK must not be on AMD's ARK-signed CRL, which is fetched fresh from AMD KDS and required. Minimum SPLs are still empty: they should be set from AMD's security bulletins.

## Deploy (outline)

1. **Generate the security policy** from the template:
   ```
   az confcom acipolicygen -a template.json
   ```
   The template holds the AGT box image (pinned by digest), the env vars AGT_OWNER, AGT_TRADE, BSC_RPC, WORK, AGT_EXAM_URL and **AGT_SKR_URL=http://localhost:8080**, and the SKR sidecar (`mcr.microsoft.com/aci/skr`).
2. **Deploy** the container group with `confidentialComputeProperties.ccePolicy` set to that policy.
3. **Send in the result.** The box attests through the sidecar, sits its exam and applies for a licence. The founder (during genesis) or the Council approves the policy's sha256 (HOST_DATA) and the UVM measurement in `tee/policy.json → azureAci`.
