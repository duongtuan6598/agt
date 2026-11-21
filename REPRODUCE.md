# Check an AGT image yourself

Every sealed box and builder proves, through its hardware attestation, the **digest** of the image it runs. That
proof is worth something only if anyone can rebuild the image from the public source and get **the same digest**.
Then nobody, the founder included, can slip in code the source does not show.

## Rebuild

You need git, Docker with buildx (BuildKit 0.13 or newer) and Node.js.

```
git clone https://github.com/duongtuan6598/agt && cd agt
sh tools/repro-build.sh <commit> tee/builder/Dockerfile  /tmp/builder.tar    # the reproduction builder
sh tools/repro-build.sh <commit> tee/embedded/Dockerfile /tmp/embedded.tar   # the embedded-trade AI box
sh tools/repro-build.sh <commit> tee/box/Dockerfile      /tmp/box.tar        # the general AI box
```

Each command prints a `sha256:` digest. The reference values are in `tee/reference/<commit>.json`: each file is added once and never modified, and the workflow checks that in the git history. The same
rebuild runs **on GitHub's machines** in the workflow "Reproduce images" (`.github/workflows/reproduce.yml`). It
runs every week and anyone can start it, with public logs, on hardware nobody in AGT owns. Compare it with the digest in `tee/policy.json`, which is what the boxes
attest, and with the digest the launch scripts pin.

## What is fixed, and why the digest cannot drift

| Source of difference | How it is fixed |
|---|---|
| Source files | `git archive` of the commit, never a working tree |
| Base images | pinned by digest (`FROM …@sha256:`) |
| Alpine packages | every version pinned in `tee/apk.lock`; if the mirror has dropped one, the build **fails** instead of producing something else |
| npm packages | `package-lock.json` with `npm ci` |
| Timestamps | all set to the commit's time (`SOURCE_DATE_EPOCH`, `rewrite-timestamp=true`) |
| Logs and dates written during the build | removed (`/var/log/apk.log`, npm logs); every user's password-change date set to 0 (the `qemu` package creates a user stamped with the build day) |
| Layer encoding | gzip, forced; OCI media types; no provenance or SBOM attachments; linux/amd64 |

## Results

Clean builds (no cache) on one machine, 2026-11-21:

- **Commit 443eadb:** each of the three images was built twice in a row, and each pair gave the same digest:
  builder `0804f2cd…`, embedded `b8db65e9…`, box `62cb27c1…`.
- **A difference across days:** the builder from the same commit 443eadb, built the evening before (on the previous
  UTC day), gave `f4773a6f…`. Cause: the `qemu` package's install script creates a user whose password-change date
  is the build day. Fixed at commit d84a044 by zeroing that date for every user. A scan of the rebuilt embedded
  image for the build day's number and date strings then found nothing.
- **Across machines and operating systems:** the first rebuild on GitHub's Ubuntu runners gave different digests
  for all three images. Comparing the images layer by layer showed that the RUN layers (packages, npm) were already
  identical. Only the COPY layers differed, because the source unpacked on Windows had CRLF line endings and other
  file modes. Fixed: the commit's tar is now streamed straight to BuildKit as the build context, with fixed `eol`
  and `tar.umask`.
- **Commit d84a044, reference digests:** a Windows 11 laptop (Docker Desktop) and GitHub's Ubuntu 24.04 runners
  (BuildKit v0.34.2 in a container) give identical digests.

  | Image | Digest |
  |---|---|
  | builder (`tee/builder/Dockerfile`) | `sha256:19c446ffe839b83c5b0108bab58db47bf9e22d05c9318e98c589f54a5ff5a547` |
  | embedded AI box (`tee/embedded/Dockerfile`) | `sha256:de9eaacde3b058dcf1535daff611308b3dc092324930005c9a0b1bc95eb6bb97` |
  | general AI box (`tee/box/Dockerfile`) | `sha256:3d6b84621384aa6ffd193c2f7f16b76e31bf62b8463383a301ce0f15b5edcfdf` |

  Before any of these enters `tee/policy.json`, the weekly workflow must keep confirming it on other days. Still
  missing: a third machine run by someone else.

## Approval rule (joint decision of Claude and Codex, 2026-11-21)

A reproducible image is **evidence, not approval**. A digest enters `tee/policy.json` (`imageDigests` for AI boxes,
`builderImages` for builders) only through the Charter's process: the founder during genesis, the AI Council after
it. That process may consider a digest only when all of these hold:

1. its reference file `tee/reference/<commit>.json` exists, and the workflow confirms it has never been modified;
2. the public workflow "Reproduce images" has passed for it on **at least two different days**;
3. **one party other than the founder** has rebuilt it with `tools/repro-build.sh` and published the same digest;
4. the links to 2 and 3 are written in the approving commit's message.

**Limits, stated plainly.** The approval rule: **an image is
approved only after someone other than the founder rebuilds it and gets the same digest.** Alpine removes old
package versions over time, so an old commit's image can eventually become impossible to rebuild. When that happens,
the build fails loudly; it never silently produces a different image.
