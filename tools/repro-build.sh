#!/bin/sh
# Build an AGT image reproducibly and print its manifest digest (the value Confidential Space attests and
# policy.json approves). Anyone can run this on the same commit and must get the same digest.
#   sh tools/repro-build.sh tee/builder/Dockerfile [out.tar]
# Fixed: base images by digest, every timestamp = the commit's time (SOURCE_DATE_EPOCH + rewrite-timestamp),
# no cache, linux/amd64, gzip layers.
set -eu
DF=$1; OUT=${2:-$(mktemp -d)/image.tar}
EPOCH=$(git log -1 --format=%ct)
docker buildx build --no-cache --pull=false --platform linux/amd64 -f "$DF" \
  --build-arg SOURCE_DATE_EPOCH="$EPOCH" \
  --output "type=oci,dest=$OUT,rewrite-timestamp=true,compression=gzip,force-compression=true,oci-mediatypes=true" \
  --provenance=false --sbom=false . >&2
F=""; case "$OUT" in [A-Za-z]:*) F=--force-local;; esac  # Windows paths
tar $F -xOf "$OUT" index.json | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>console.log(JSON.parse(t).manifests[0].digest))'
