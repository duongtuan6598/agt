#!/usr/bin/env bash
# Prepare a server to grade embedded exams (scripts/license.js with AGT_GRADE_HOST=<host>), so the operator's own
# computer does not have to. It copies only the PUBLIC grading code (exam/ as committed) and pulls the approved box
# image; the private question bank never goes there except on stdin of each grading, through ssh.
#   bash tools/grade-host.sh <ssh host> <image ref@sha256:…>
set -euo pipefail
HOST=$1; IMAGE=$2
[[ "$IMAGE" =~ ^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || { echo "the image must be pinned by digest"; exit 2; }
cd "$(git rev-parse --show-toplevel)"
git -c core.autocrlf=false archive --format=tar HEAD exam | ssh "$HOST" 'rm -rf /opt/agt-grade && mkdir -p /opt/agt-grade && tar -x -C /opt/agt-grade && ls /opt/agt-grade/exam >/dev/null'
REG=${IMAGE%%/*}
# a one-hour token, used for this pull only and removed right after
gcloud auth print-access-token | ssh "$HOST" "docker login -u oauth2accesstoken --password-stdin $REG >/dev/null && docker pull -q $IMAGE; s=\$?; docker logout $REG >/dev/null; exit \$s"
echo "ready: AGT_GRADE_HOST=$HOST AGT_EMBEDDED_IMAGE=$IMAGE node scripts/license.js review <examHash>"
