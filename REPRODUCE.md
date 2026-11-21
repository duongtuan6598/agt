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

Each command prints a `sha256:` digest. The reference values are in `tee/reference-digests.json`. The same
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
- **Commit d84a044 (current reference):** each image was built twice, and each pair gave the same digest.

  | Image | Digest |
  |---|---|
  | builder (`tee/builder/Dockerfile`) | `sha256:26c7092cc6c426a9ed73017908ba398028f184fbc2b6acca77362a5742247ef9` |
  | embedded AI box (`tee/embedded/Dockerfile`) | `sha256:758c9143241ca5af05d7aed83c53601c4cae3491f3d385879616073a85790aa9` |
  | general AI box (`tee/box/Dockerfile`) | `sha256:d198da1d35edb7d15ddb4830d818d624e0ed91fa7b6ca76d336cc50a2955c4d5` |

  **Still to do:** a rebuild on another machine and on another day. Until then, none of these goes into
  `tee/policy.json`.

**Limits, stated plainly.** Two builds on one machine show that nothing in the build depends on the time or the
machine's state. They do not yet show it across different machines. The approval rule is therefore: **an image is
approved only after someone other than the founder rebuilds it and gets the same digest.** Alpine removes old
package versions over time, so an old commit's image can eventually become impossible to rebuild. When that happens,
the build fails loudly; it never silently produces a different image.
