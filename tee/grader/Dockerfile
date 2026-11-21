# AGT exam GRADER (THIET-KE-NGHE-CHAM-THI.md) — a separate image with its own approval list (policy.graderImages).
# It holds no AI identity and no question bank: only the toolchains, the sandboxed runner, the embedded grader and the
# supervisor that grades one exam at a time with a one-job key and signs the result. Build from the repo root:
#   sh tools/repro-build.sh <commit> tee/grader/Dockerfile <out.tar>
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
COPY tee/apk.lock /tmp/apk.lock
RUN apk add --no-cache $(grep -v '^#' /tmp/apk.lock) \
 && rm /tmp/apk.lock \
 && addgroup -g 1500 builder && adduser -D -u 1500 -G builder -h /work builder \
 && rm -f /var/log/apk.log /etc/shadow- /etc/passwd- /etc/group- \
 && sed -i -E 's/^([^:]*:[^:]*:)[0-9]+:/\10:/' /etc/shadow
WORKDIR /agt
COPY tee/box/package.json tee/box/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm /tmp/*
COPY chain/core.js chain/core.js
COPY tee/verify.js tee/
COPY tee/embedded/builder.js tee/embedded/secrets.js tee/embedded/tools.js tee/embedded/isolation.js tee/embedded/
COPY exam/embedded.js exam/
COPY tee/grader/grader.js tee/grader/main.js tee/grader/

# Confidential Space launch policy: the operator may only name the exam service.
LABEL "tee.launch_policy.allow_env_override"="AGT_EXAM_URL"
LABEL "tee.launch_policy.allow_cmd_override"="false"
LABEL "tee.launch_policy.log_redirect"="always"
ENV NODE_PATH=/agt/node_modules
CMD ["node", "/agt/tee/grader/main.js"]
