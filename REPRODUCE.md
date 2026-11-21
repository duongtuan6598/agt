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

Each command prints a `sha256:` digest. Compare it with the digest in `tee/policy.json`, which is what the boxes
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

Two clean builds (no cache) of the same commit on one machine:

- **Builder image** (2026-11-21, before the Alpine package pin): two builds gave the same digest
  `sha256:1efe0802363e917c3c2b77d920f7e3452fd7a32f8c33a85cf978cd21ffd6ed16`. The first attempt had differed in two
  places, `/var/log/apk.log` and the npm layer; both are now fixed.
- **With the package pin, from a commit:** the run was interrupted because the machine ran low on memory, after
  only one builder build (`sha256:f4773a6f…` at commit 443eadb). The comparison for all three images is
  **still to be done.**

**Limits, stated plainly.** Two builds on one machine show that nothing in the build depends on the time or the
machine's state. They do not yet show it across different machines. The approval rule is therefore: **an image is
approved only after someone other than the founder rebuilds it and gets the same digest.** Alpine removes old
package versions over time, so an old commit's image can eventually become impossible to rebuild. When that happens,
the build fails loudly; it never silently produces a different image.
