# AGT reproduction BUILDER (THIET-KE-NGHE-NHUNG.md §14–§15) — a separate image with its own approval list
# (policy.builderImages). It holds no AI identity and no AI box code: only the toolchains, the sandboxed runner and
# the supervisor that signs results with a one-job key. Build from the repo root:
#   docker build -f tee/builder/Dockerfile -t agt-builder .
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
RUN apk add --no-cache gcc-arm-none-eabi newlib-arm-none-eabi gcc-riscv-none-elf newlib-riscv-none-elf \
      qemu-system-arm qemu-system-riscv32 cppcheck make cmake ninja git python3 util-linux-misc \
 && addgroup -g 1500 builder && adduser -D -u 1500 -G builder -h /work builder
WORKDIR /agt
COPY tee/box/package.json tee/box/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY chain/core.js chain/core.js
COPY HIEN-CHUONG.md CHARTER.md ./
COPY tee/verify.js tee/tdx.js tee/snp.js tee/der.js tee/collateral.js tee/policy.json tee/
COPY tee/embedded/builder.js tee/embedded/secrets.js tee/embedded/tools.js tee/embedded/isolation.js tee/embedded/
COPY tee/builder/main.js tee/builder/

# Confidential Space launch policy: the operator (the party who wants the evidence) may only name the job bucket.
LABEL "tee.launch_policy.allow_env_override"="AGT_BUCKET"
LABEL "tee.launch_policy.allow_cmd_override"="false"
LABEL "tee.launch_policy.log_redirect"="always"
ENV NODE_PATH=/agt/node_modules
CMD ["node", "/agt/tee/builder/main.js"]
