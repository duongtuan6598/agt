# AGT sealed box — container image for Google Confidential Space (Intel TDX / AMD SEV).
# Build from the repo root:  docker build -f tee/box/Dockerfile -t agt-box .
# Base images are pinned by digest so anyone can rebuild and get the same image digest.
FROM cometbft/cometbft@sha256:08f635fe1eff3bdcbe9d9a57091811351c55de66fbaa80190b28fe436a08356f AS cmt

FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
COPY --from=cmt /usr/bin/cometbft /usr/local/bin/cometbft
WORKDIR /agt
COPY tee/box/package.json tee/box/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm /tmp/*
COPY HIEN-CHUONG.md CHARTER.md ./
COPY chain/core.js chain/address.js chain/sig.js chain/agt1-client.js chain/
COPY chain/abci/app.js chain/abci/app.js
COPY chain/abci/proto chain/abci/proto
COPY exam/lib.js exam/lib.js
COPY exam-worker/client.js exam-worker/client.js
COPY tee/verify.js tee/escrow.js tee/tdx.js tee/snp.js tee/der.js tee/collateral.js tee/policy.json tee/
COPY public/forms public/forms
COPY tee/embedded/github.js tee/embedded/oss-check.js tee/embedded/oss-hunt.js tee/embedded/workspace.js tee/embedded/
COPY tee/box/start.js tee/box/agt1-work.js tee/box/answer.js tee/box/models.js tee/box/models.json tee/box/system-prompt.txt tee/box/

# Confidential Space launch policy: the operator may only point the box at public data.
# It cannot override the command, cannot inject keys, and logs never contain secrets.
# Secrets never go in env (env values appear in the public attestation token): the model API key is
# read from Secret Manager by name. The trust policy for peers is baked in (tee/policy.json).
LABEL "tee.launch_policy.allow_env_override"="AGT_CHAIN_ID,AGT_GENESIS_URL,AGT_PEERS,BSC_RPC,WORK,BRIDGE,CONFIRMATIONS,AGT_PEER_BOXES,AGT_ESCROW_URL,AGT_EXAM_URL,AGT_OWNER,AGT_TRADE,AGT_AI_NAME,AGT_MODEL_KEY_SECRET,AGT_GITHUB_TOKEN_SECRET,AGT_SIGNOFF,AGT_WORK_EVERY_SEC,AGT_SKR_URL,AGT_MODEL_PROVIDER,AGT_PRICE_FEEDS,ENGAGEMENT,MAINTENANCE"
LABEL "tee.launch_policy.allow_cmd_override"="false"
LABEL "tee.launch_policy.log_redirect"="always"

EXPOSE 26656 26657 8080
ENV NODE_PATH=/agt/node_modules
CMD ["node", "/agt/tee/box/start.js"]
