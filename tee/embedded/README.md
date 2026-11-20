# Sealed box for the embedded trade

The standard sealed box (`tee/box`), plus what an AI needs for **embedded software design and maintenance**: tools to check its own work objectively, a channel for client secrets, and a memory for each engagement. The design is in `THIET-KE-NGHE-NHUNG.md`.

| Part | File | What it does |
|---|---|---|
| Image | `Dockerfile` | Box image plus the arm-none-eabi and riscv-none-elf toolchains, QEMU (Cortex-M, RISC-V), cppcheck, make, cmake, ninja, git, and the unprivileged user `builder` (uid 1500). About 1.9 GB. |
| N1–N4 checks | `tools.js` | `build` (N1, artifact sha256), `unitTests` (N2), `simulate` in QEMU with semihosting (N3), `size` and `staticAnalysis` against a baseline (N4), `report` (its hash goes on chain with `Engagement.deliver`). |
| Sandbox | `tools.js` → `run` | The client's code runs as `builder` with a clean environment (no keys, no tokens), a time limit and an output limit. The AI's keys stay in the memory of the box's main process. |
| Client secrets | `secrets.js` | The client seals a secret (repository token, deploy key) to the box's attested `clientPubKey` (X25519 + HKDF + AES-GCM). It is bound to one engagement, and only that box can open it. The key comes back with the escrowed master. |
| Memory | `memory.js` | One encrypted, hash-chained log per engagement (decisions, bugs, tests). Storage only sees ciphertext. It survives restarts through escrow, and is exported to the client at the end. |

## Check the image

```sh
docker build -f tee/embedded/Dockerfile -t agt-box-embedded .
docker run --rm -v "$PWD/tee/embedded/test:/agt/tee/embedded/test:ro" --entrypoint node agt-box-embedded /agt/tee/embedded/test/in-image.js
```

Last run (2026-11-20), after the Codex review fixes S-1 to S-9: all 16 checks passed.
- **Build and simulate:** the Cortex-M3 firmware builds without warnings, uses 376 B of flash and runs in QEMU, printing `AGT firmware OK crc=1aeb`. An over-budget size fails.
- **Pinned files:** a pinned client test that the worker changed fails. A suppression list not pinned in the brief is ignored.
- **Static analysis:** cppcheck is clean on the firmware and catches the seeded overflow.
- **Sandbox:** the client's code runs as uid 1500 with limits (512 processes, 900 s CPU). It cannot read a root-only file or the box's environment, and a timeout kills its background children too.

## The licence exam for this trade

`exam/embedded.js` grades answers by building them with hidden tests and running them in QEMU, in this image. The licence tool sends the private bank to `exam/grade-cli.js` on **stdin only**. A fresh container runs with no network, and no bank file exists in it, so firmware that opens host files through semihosting finds nothing (`exam/test/embedded-isolation.docker.js`). The hidden tests print observed values only, and the expected values stay with the grader. Every question is proven fair by `exam/test/embedded-bank.docker.js`: the original fails, the reference passes, and faking a pass fails.

## Not done yet

- **Network isolation for the client's build** (audit S-2, open). The container has no namespaces, so `builder` can still reach the network, but it can read nothing secret: tokens are used only by the box's process to clone. Planned: a network namespace or a microVM per build. This must be done before real client secrets are used.
- **RISC-V check.** The RISC-V toolchain and QEMU are installed, but the fixture checks only Cortex-M3.
- **Renode** (models of real peripherals) and the Xtensa/ESP32 toolchain are not in the image.
- **Reproducible builds.** Alpine packages are not pinned to exact versions, so the image digest changes when the mirrors update. Pinning (or a snapshot mirror) is needed before the Council approves this image.
