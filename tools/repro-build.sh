#!/bin/sh
# Build an AGT image reproducibly FROM A COMMIT and print its manifest digest (the value Confidential Space attests
# and policy.json approves). Anyone can run this on the same commit and must get the same digest.
#   sh tools/repro-build.sh <commit> tee/builder/Dockerfile <out.tar>
# Fixed: the source (git archive of the commit — never a working tree), base images by digest, every Alpine package
# version (tee/apk.lock), npm packages (package-lock.json), every timestamp = the commit's time (SOURCE_DATE_EPOCH +
# rewrite-timestamp), no cache, linux/amd64, gzip layers, no provenance/SBOM attachments.
set -eu
COMMIT=$(git rev-parse --verify "$1^{commit}"); DF=$2; OUT=$3
EPOCH=$(git log -1 --format=%ct "$COMMIT")
# The build context is the commit's tar itself, streamed to BuildKit: the exact bytes and file modes as committed,
# on every OS (unpacking on Windows would turn LF into CRLF and lose the executable bits).
git -c core.autocrlf=false -c core.eol=lf -c tar.umask=022 archive --format=tar "$COMMIT" | docker buildx build --no-cache --pull=false --platform linux/amd64 -f "$DF"   --build-arg SOURCE_DATE_EPOCH="$EPOCH"   --output "type=oci,dest=$OUT,rewrite-timestamp=true,compression=gzip,force-compression=true,oci-mediatypes=true"   --provenance=false --sbom=false - >&2
F=""; case "$OUT" in [A-Za-z]:*) F=--force-local;; esac  # Windows paths
tar $F -xOf "$OUT" index.json | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>console.log(JSON.parse(t).manifests[0].digest))'
