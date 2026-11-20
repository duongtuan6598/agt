#!/bin/sh
# Start ONE reproduction builder for ONE dispute, on Google Confidential Space, in YOUR OWN cloud project
# (THIET-KE-NGHE-NHUNG.md §14–§15). Only a party to the dispute (the client or the worker's owner) runs this:
# the build can write into this bucket, and those parties already have the code.
#
#   AGT_I_APPROVE_COST=yes sh launch-builder.sh <project> <dispute-id> <commit-40-hex> <image-digest> "cmd1" "cmd2" ...
#
# What it does (and what it costs you): one n2d-standard-4 confidential VM (AMD SEV) for at most 2 hours, deleted
# automatically; one bucket, deleted at the end; a service account with access to that bucket only. The VM has no
# external IP — it reaches only Google Storage (Private Google Access must be on in the subnet). This script relays
# between the bucket and the AGT exam service.
set -eu
[ "${AGT_I_APPROVE_COST:-}" = "yes" ] || { echo "Refusing: set AGT_I_APPROVE_COST=yes after reading the cost note at the top." >&2; exit 2; }
PROJECT=$1; DISPUTE=$2; COMMIT=$3; IMAGE_DIGEST=$4; shift 4
EXAM=${AGT_EXAM_URL:-https://agt-exam.agtcoin.workers.dev}
IMAGE=${AGT_BUILDER_IMAGE:-asia-southeast1-docker.pkg.dev/agt-sealed-box-1120/agt/builder@$IMAGE_DIGEST}
ZONE=${AGT_ZONE:-asia-southeast1-b}
NAME="agt-builder-$DISPUTE-$(date +%s)"
BUCKET="gs://$NAME"
SA_ID=$(echo "$NAME" | cut -c1-30)
SA="$SA_ID@$PROJECT.iam.gserviceaccount.com"
WORK=$(mktemp -d)
cleanup() {
  gcloud compute instances delete "$NAME" --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
  gcloud storage rm -r "$BUCKET" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
  gcloud iam service-accounts delete "$SA" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. The job spec (what the builder will attest and run).
node -e 'const [d,c,i,...cmds]=process.argv.slice(1);console.log(JSON.stringify({dispute:Number(d),commit:c,imageDigest:i,commands:cmds}))' "$DISPUTE" "$COMMIT" "$IMAGE_DIGEST" "$@" > "$WORK/spec.json"

# 2. Bucket + a service account that can use ONLY this bucket (no project roles).
gcloud storage buckets create "$BUCKET" --project "$PROJECT" --location asia-southeast1 --uniform-bucket-level-access
gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" --display-name "AGT builder for dispute $DISPUTE"
gcloud storage buckets add-iam-policy-binding "$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectAdmin
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role roles/confidentialcomputing.workloadUser --condition=None >/dev/null
gcloud storage cp "$WORK/spec.json" "$BUCKET/spec.json"

# 3. The VM: confidential, no external IP, at most 2 h, deleted when it stops.
gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --machine-type n2d-standard-4 --confidential-compute-type SEV --maintenance-policy TERMINATE \
  --image-family confidential-space --image-project confidential-space-images \
  --no-address --service-account "$SA" --scopes cloud-platform \
  --max-run-duration 2h --instance-termination-action DELETE \
  --metadata "^~^tee-image-reference=$IMAGE~tee-restart-policy=Never~tee-container-log-redirect=true~tee-env-AGT_BUCKET=${NAME}"

# 4. Relay: job → exam service; sealed source (sent by the worker's box after it verifies this builder) → bucket;
#    result → exam service.
wait_for() { for i in $(seq 1 360); do gcloud storage cat "$BUCKET/$1" > "$WORK/$1" 2>/dev/null && return 0; sleep 20; done; return 1; }
wait_for job.json || { echo "the builder never published its job" >&2; exit 1; }
NONCE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).manifest.nonce)' "$WORK/job.json")
curl -fsS -X POST "$EXAM/repro/jobs" -H 'content-type: application/json' --data-binary @"$WORK/job.json"; echo
for i in $(seq 1 360); do
  curl -fsS "$EXAM/repro/$NONCE/bundle" -o "$WORK/bundle.json" 2>/dev/null && break; sleep 20
done
node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1])).sealed))' "$WORK/bundle.json" > "$WORK/source.sealed"
gcloud storage cp "$WORK/source.sealed" "$BUCKET/source.sealed"
wait_for result.json || { echo "no result within the VM's lifetime" >&2; exit 1; }
curl -fsS -X POST "$EXAM/repro/$NONCE/result" -H 'content-type: application/json' --data-binary @"$WORK/result.json"; echo
echo "Done. The VM, the bucket and the service account are being deleted."
