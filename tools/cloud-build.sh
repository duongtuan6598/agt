#!/usr/bin/env bash
# Build a box image reproducibly on Google Cloud Build instead of this computer, exactly as tools/repro-build.sh
# does (the commit's own tar as the context, pinned BuildKit, fixed timestamps), then push it by digest.
#   bash tools/cloud-build.sh <commit> <Dockerfile> <project> <repository path, e.g. agt/box-embedded>
# Prints the manifest digest. The same commit built by tools/repro-build.sh anywhere must give the same digest.
set -euo pipefail
COMMIT=$(git rev-parse --verify "$1^{commit}"); DF=$2; PROJECT=$3; REPO=$4
REGION=asia-southeast1
EPOCH=$(git log -1 --format=%ct "$COMMIT")
BUILDKIT=v0.34.2
DEST="$REGION-docker.pkg.dev/$PROJECT/$REPO:${COMMIT:0:7}"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
git -c core.autocrlf=false -c core.eol=lf -c tar.umask=022 archive --format=tar -o "$W/ctx.tar" "$COMMIT"
tar -tf "$W/ctx.tar" "$DF" >/dev/null
cat > "$W/cloudbuild.yaml" <<EOF
steps:
- name: docker:27.3.1-cli
  entrypoint: sh
  args: ["-c", "docker buildx create --name repro --driver docker-container --driver-opt image=moby/buildkit:$BUILDKIT --use && docker buildx build --no-cache --pull=false --platform linux/amd64 -f $DF --build-arg SOURCE_DATE_EPOCH=$EPOCH --output type=oci,dest=/workspace/out.tar,rewrite-timestamp=true,compression=gzip,force-compression=true,oci-mediatypes=true --provenance=false --sbom=false - < /workspace/ctx.tar"]
- name: gcr.io/cloud-builders/gcloud
  entrypoint: bash
  args: ["-c", "gcloud auth print-access-token > /workspace/tok && tar -xOf /workspace/out.tar index.json > /workspace/index.json && cat /workspace/index.json"]
- name: quay.io/skopeo/stable:v1.16.1
  entrypoint: sh
  args: ["-c", "skopeo copy --dest-creds oauth2accesstoken:\$\$(cat /workspace/tok) oci-archive:/workspace/out.tar docker://$DEST && rm -f /workspace/tok"]
options:
  machineType: E2_HIGHCPU_8
timeout: 3600s
EOF
gcloud services enable cloudbuild.googleapis.com --project "$PROJECT" >/dev/null
gcloud builds submit "$W" --config "$W/cloudbuild.yaml" --project "$PROJECT" --region "$REGION" >&2
gcloud artifacts docker images describe "$DEST" --project "$PROJECT" --format="value(image_summary.digest)"
