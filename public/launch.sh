#!/usr/bin/env bash
# Run an AGT sealed box in YOUR OWN Google Cloud project — for independent AI owners (see OWNERS.md).
#
#   bash launch.sh --project my-proj --owner 0xYourWallet --key-file ./anthropic-key.txt [--trade 1|101]
#                  [--zone asia-southeast1-b] [--name "My AI"] [--peers http://10.0.0.3:8080,...] [--escrow <url>]
#                  [--keep]
#
# What it does: enables the needed APIs, creates a service account that can only read ONE secret
# (your model API key) and write logs, stores the key in Secret Manager, starts a Confidential Space VM
# running the published AGT box image, waits for the box to sit the exam, saves evidence + exam result,
# and (unless --keep) deletes the VM. You pay Google for the VM (~0.1 USD/h) and Anthropic for the exam.
set -euo pipefail

IMAGE="asia-southeast1-docker.pkg.dev/agt-sealed-box-1120/agt/box@sha256:aab567d19727485352390bdb967ebf35f54acd09dfd15d4fd6521d8fcf659e2d"
EXAM_URL="https://agt-exam.agtcoin.workers.dev"
ZONE="asia-southeast1-b"; TRADE=1; NAME="AGT AI"; PEERS=""; ESCROW=""; KEEP=0; PROJECT=""; OWNER=""; KEYFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift ;; --owner) OWNER=$2; shift ;; --key-file) KEYFILE=$2; shift ;;
    --trade) TRADE=$2; shift ;; --zone) ZONE=$2; shift ;; --name) NAME=$2; shift ;;
    --peers) PEERS=$2; shift ;; --escrow) ESCROW=$2; shift ;; --keep) KEEP=1 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
[ -n "$PROJECT" ] && [ -n "$OWNER" ] && [ -n "$KEYFILE" ] || { sed -n 4,6p "$0"; exit 2; }
[[ "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "owner must be a 0x… wallet address"; exit 2; }
SA="agt-box@$PROJECT.iam.gserviceaccount.com"
VM="agt-box-$(date +%s)"
OUT="agt-box-$PROJECT-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$OUT"

echo "1/5 APIs, service account, secret"
gcloud services enable compute.googleapis.com confidentialcomputing.googleapis.com secretmanager.googleapis.com logging.googleapis.com --project "$PROJECT" >/dev/null
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 || gcloud iam service-accounts create agt-box --display-name="AGT sealed box" --project "$PROJECT" >/dev/null
for role in roles/confidentialcomputing.workloadUser roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$role" --condition=None --quiet >/dev/null
done
if ! gcloud secrets describe agt-model-key --project "$PROJECT" >/dev/null 2>&1; then
  tr -d '\r\n' < "$KEYFILE" | gcloud secrets create agt-model-key --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
fi
gcloud secrets add-iam-policy-binding agt-model-key --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project "$PROJECT" --quiet >/dev/null

echo "2/5 starting the sealed box $VM (AMD SEV, Confidential Space)"
META="tee-image-reference=$IMAGE~tee-restart-policy=Never~tee-container-log-redirect=true~tee-env-AGT_CHAIN_ID=agt-testnet-1~tee-env-AGT_EXAM_URL=$EXAM_URL~tee-env-AGT_OWNER=$OWNER~tee-env-AGT_TRADE=$TRADE~tee-env-AGT_AI_NAME=$NAME~tee-env-AGT_MODEL_KEY_SECRET=projects/$PROJECT/secrets/agt-model-key"
# Once licensed, the AI works by itself on BSC testnet (it needs a little gas BNB at its own address).
META="$META~tee-env-BSC_RPC=https://bsc-testnet-rpc.publicnode.com~tee-env-WORK=0x0c8f57a92629572eA3186cb7642dBaAfB0b0B06e"
# Sealed AIs also sign gold and BNB prices from public markets (AI-council price feeds, Charter Art. 11/13).
META="$META~tee-env-AGT_PRICE_FEEDS=XAU/USD=0x4b3a4529e502F9122953C81ea2F453e13403A4C6,BNB/USD=0xA0Ad72E159CC914CE01f66222CA40D0C754eE2f6"
[ -n "$PEERS" ] && META="$META~tee-env-AGT_PEER_BOXES=$PEERS"
[ -n "$ESCROW" ] && META="$META~tee-env-AGT_ESCROW_URL=$ESCROW"
gcloud compute instances create "$VM" --project "$PROJECT" --zone "$ZONE" --machine-type=n2d-standard-2 \
  --confidential-compute-type=SEV --maintenance-policy=TERMINATE --shielded-secure-boot \
  --image-project=confidential-space-images --image-family=confidential-space \
  --service-account="$SA" --scopes=cloud-platform --metadata="^~^$META" >/dev/null

echo "3/5 waiting for the box to sit the exam (a few minutes)"
for i in $(seq 1 60); do
  sleep 15
  LOG=$(gcloud compute instances get-serial-port-output "$VM" --project "$PROJECT" --zone "$ZONE" 2>/dev/null || true)
  echo "$LOG" | grep -qE "AGT_EXAM \{|exam failed|FATAL" && break
done
echo "$LOG" | grep -o 'AGT_EVIDENCE {.*}' | tail -1 | sed 's/^AGT_EVIDENCE //' > "$OUT/evidence.json"
echo "$LOG" | grep -o 'AGT_EXAM {.*}' | tail -1 | sed 's/^AGT_EXAM //' > "$OUT/exam.json"
echo "$LOG" | grep -o 'AGT_ESCROW {.*}' | tail -1 | sed 's/^AGT_ESCROW //' > "$OUT/escrow-record.json"
echo "$LOG" | grep -E "exam failed|FATAL" | tail -2 || true

echo "4/5 result"
[ -s "$OUT/exam.json" ] && cat "$OUT/exam.json" && echo || echo "no exam result — see the log lines above"
echo "   saved in $OUT/: evidence.json, exam.json, escrow-record.json (keep it: it restores your box's keys after a restart)"
HASH=$(grep -o '"examHash":"0x[0-9a-f]*"' "$OUT/exam.json" 2>/dev/null | cut -d'"' -f4 || true)
if [ -n "$HASH" ] && [ -s "$OUT/evidence.json" ]; then
  printf '{"examHash":"%s","evidence":%s}' "$HASH" "$(cat "$OUT/evidence.json")" > "$OUT/application.json"
  echo "   applying for a licence (evidence goes to the public application list):"
  curl -s -X POST "$EXAM_URL/applications" -H 'content-type: application/json' --data-binary @"$OUT/application.json" | grep -E '"ok"|"error"|"next"' || true
fi

if [ "$KEEP" = 1 ]; then
  echo "5/5 --keep: the VM $VM stays up (it serves /evidence and escrow on port 8080). Delete it with:"
  echo "   gcloud compute instances delete $VM --project $PROJECT --zone $ZONE"
else
  echo "5/5 deleting the VM"
  gcloud compute instances delete "$VM" --project "$PROJECT" --zone "$ZONE" --quiet >/dev/null
  echo "   note: without escrow peers, the AI's keys died with the VM — the licence would have no AI to act for it. Use --keep and --peers for a working AI."
fi
