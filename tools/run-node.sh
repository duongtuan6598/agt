#!/usr/bin/env bash
# Run your own agt-2 node, on any Linux or macOS machine with Docker. It downloads every block from the network and
# checks each one with the AGT rules on YOUR machine, then keeps following the chain. You then read and send through
# your own node (http://127.0.0.1:26657), with no door, no company and no one to trust in between.
#   curl -O https://agtcoin.pages.dev/run-node.sh      (the same file is tools/run-node.sh in the repository)
#   bash run-node.sh up        # start (first run downloads the code and the genesis)
#   bash run-node.sh status    # height of your node
#   bash run-node.sh down      # stop (your data stays in $DIR)
# A node that follows holds no key and signs nothing. A licensed AI's box becomes a validator by binding its key.
set -euo pipefail
DIR=${DIR:-$HOME/agt-node}
REPO=${REPO:-https://github.com/duongtuan6598/agt}
GENESIS=${GENESIS:-https://agtcoin.pages.dev/chain/agt-2-genesis.json}
PEERS=${PEERS:-194daa041a7901786a6cad1656e50cf90404f0ee@151.247.112.2:26656}
CMT=cometbft/cometbft:v0.38.26
NODE=node:20-alpine
NET=agt-follow
RPC_PORT=${RPC_PORT:-26657}
cmd=${1:-status}

down() {
  docker rm -f agt-follow-cmt agt-follow-app >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

if [ "$cmd" = up ]; then
  command -v docker >/dev/null || { echo "Docker is needed: https://docs.docker.com/get-docker/"; exit 2; }
  mkdir -p "$DIR"
  if [ -d "$DIR/src/.git" ]; then git -C "$DIR/src" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$DIR/src"; fi
  # the chain app needs three packages; installed next to it, inside a container
  docker run --rm -v "$DIR/src/chain:/chain" -w /chain "$NODE" sh -c \
    "npm i -s --no-save --no-package-lock ethers@6.17.0 @grpc/grpc-js@1.12.6 @grpc/proto-loader@0.7.13 >/dev/null"
  if [ ! -f "$DIR/cometbft/config/genesis.json" ]; then
    mkdir -p "$DIR/cometbft"
    docker run --rm --user "$(id -u):$(id -g)" -v "$DIR/cometbft:/cometbft" "$CMT" init --home /cometbft >/dev/null
    curl -fsSL "$GENESIS" -o "$DIR/cometbft/config/genesis.json"
    C="$DIR/cometbft/config/config.toml"
    sed -i.bak -e 's|^proxy_app = .*|proxy_app = "127.0.0.1:26658"|' -e 's|^abci = .*|abci = "grpc"|' \
      -e "s|^persistent_peers = .*|persistent_peers = \"$PEERS\"|" -e 's|^moniker = .*|moniker = "agt-follower"|' \
      -e 's|^laddr = "tcp://127.0.0.1:26657"|laddr = "tcp://0.0.0.0:26657"|' "$C"
  fi
  down
  docker network create "$NET" >/dev/null
  docker run -d --name agt-follow-app --restart unless-stopped --network "$NET" -p "127.0.0.1:$RPC_PORT:26657" \
    -v "$DIR/src/chain:/chain:ro" -v "$DIR:/data" -e PORT=26658 -e STATE_FILE=/data/app-state.json \
    -e BTC_ESPLORA=https://mempool.space/testnet4/api "$NODE" node /chain/abci/app.js >/dev/null
  docker run -d --name agt-follow-cmt --restart unless-stopped --network container:agt-follow-app \
    -v "$DIR/cometbft:/cometbft" --user "$(id -u):$(id -g)" --entrypoint cometbft "$CMT" node --home /cometbft >/dev/null
  echo "your agt-2 node is starting: it checks every block from genesis. RPC: http://127.0.0.1:$RPC_PORT · status: bash $0 status"
elif [ "$cmd" = down ]; then
  down; echo "stopped (data kept in $DIR)"
else
  curl -s "127.0.0.1:$RPC_PORT/status" | sed -n 's/.*"network":"\([^"]*\)".*"latest_block_height":"\([0-9]*\)".*"catching_up":\([a-z]*\).*/\1 · height \2 · catching up: \3/p'
fi
