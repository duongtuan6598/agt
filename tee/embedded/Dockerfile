# AGT sealed box for the EMBEDDED trade (design & maintenance of embedded software, THIET-KE-NGHE-NHUNG.md):
# the standard sealed box plus the tools the AI needs to check its own work objectively (N1–N4):
# ARM and RISC-V bare-metal toolchains, QEMU for Cortex-M and RISC-V, cppcheck, make/cmake/ninja, git.
# The client's code runs as the unprivileged user `builder` (uid 1500), never as the box's user.
# Build from the repo root:  docker build -f tee/embedded/Dockerfile -t agt-box-embedded .
# Base images are pinned by digest so anyone can rebuild and get the same image digest.
FROM cometbft/cometbft@sha256:08f635fe1eff3bdcbe9d9a57091811351c55de66fbaa80190b28fe436a08356f AS cmt

FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
COPY --from=cmt /usr/bin/cometbft /usr/local/bin/cometbft
COPY tee/apk.lock /tmp/apk.lock
RUN apk add --no-cache $(grep -v '^#' /tmp/apk.lock) \
 && rm /tmp/apk.lock \
 && addgroup -g 1500 builder && adduser -D -u 1500 -G builder -h /work builder \
 && rm -f /var/log/apk.log /etc/shadow- /etc/passwd- /etc/group- \
 && sed -i -E 's/^([^:]*:[^:]*:)[0-9]+:/\10:/' /etc/shadow
WORKDIR /agt
COPY tee/box/package.json tee/box/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm /tmp/*
COPY HIEN-CHUONG.md CHARTER.md ./
COPY chain/core.js chain/agt1-client.js chain/address.js chain/sig.js chain/
COPY chain/abci/app.js chain/abci/app.js
COPY chain/abci/proto chain/abci/proto
COPY exam/lib.js exam/lib.js
COPY exam-worker/client.js exam-worker/client.js
COPY tee/verify.js tee/escrow.js tee/tdx.js tee/snp.js tee/der.js tee/collateral.js tee/policy.json tee/
COPY public/forms public/forms
COPY tee/embedded/tools.js tee/embedded/secrets.js tee/embedded/memory.js tee/embedded/repo-memory.js tee/embedded/workspace.js tee/embedded/engage-agent.js tee/embedded/isolation.js tee/embedded/forge.js tee/embedded/builder.js tee/embedded/agt1-engage.js tee/embedded/
COPY public/abi public/abi
COPY tee/builder/verify-builder.js tee/builder/
COPY tee/embedded/fixtures tee/embedded/fixtures
COPY tee/box/start.js tee/box/agt1-work.js tee/box/engage-wiring.js tee/box/answer.js tee/box/models.js tee/box/models.json tee/box/prices.js tee/box/system-prompt.txt tee/box/

# Confidential Space launch policy: the operator may only point the box at public data.
# It cannot override the command, cannot inject keys, and logs never contain secrets.
# Secrets never go in env (env values appear in the public attestation token): the model API key is
# read from Secret Manager by name. The trust policy for peers is baked in (tee/policy.json).
LABEL "tee.launch_policy.allow_env_override"="AGT1_RPC,AGT_CHAIN_ID,AGT_GENESIS_URL,AGT_PEERS,BSC_RPC,WORK,BRIDGE,CONFIRMATIONS,AGT_PEER_BOXES,AGT_ESCROW_URL,AGT_EXAM_URL,AGT_OWNER,AGT_TRADE,AGT_AI_NAME,AGT_MODEL_KEY_SECRET,AGT_WORK_EVERY_SEC,AGT_SKR_URL,AGT_MODEL_PROVIDER,AGT_PRICE_FEEDS,ENGAGEMENT,MAINTENANCE"
LABEL "tee.launch_policy.allow_cmd_override"="false"
LABEL "tee.launch_policy.log_redirect"="always"

EXPOSE 26656 26657 8080
ENV NODE_PATH=/agt/node_modules
CMD ["node", "/agt/tee/box/start.js"]
