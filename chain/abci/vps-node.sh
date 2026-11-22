#!/usr/bin/env bash
# Run the agt-2 caretaker node on a Linux server (the founder's VPS). Same containers as provisional.js on the
# laptop: the AGT app, CometBFT, and the bridge that dials OUT to the public RPC door. The P2P port 26656 is public;
# the RPC 26657 stays on localhost (clients use the door, or run their own node).
#   DIR=/opt/agt-chain bash vps-node.sh up | down | status
# DIR holds: app/ (the chain code with node_modules), cometbft/ (config, keys, data), app-state.json, bridge.env
set -euo pipefail
DIR=${DIR:-/opt/agt-chain}
CMT=cometbft/cometbft:v0.38.26
NODE=node:20-alpine
NET=agt-chain
cmd=${1:-status}

down() {
  docker rm -f agt-bridge agt-cmt agt-app >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

if [ "$cmd" = up ]; then
  down
  docker network create "$NET" >/dev/null
  docker run -d --name agt-app --restart unless-stopped --network "$NET" \
    -p 127.0.0.1:26657:26657 -p 26656:26656 --memory 300m \
    -v "$DIR/app:/chain:ro" -v "$DIR:/data" \
    -e PORT=26658 -e STATE_FILE=/data/app-state.json -e BSC_RPC=https://bsc-testnet-rpc.publicnode.com -e CMT_RPC=http://127.0.0.1:26657 \
    "$NODE" node /chain/abci/app.js >/dev/null
  docker run -d --name agt-cmt --restart unless-stopped --network container:agt-app --memory 300m \
    -v "$DIR/cometbft:/cometbft" --entrypoint cometbft "$CMT" node --home /cometbft >/dev/null
  if [ -f "$DIR/bridge.env" ]; then
    docker run -d --name agt-bridge --restart unless-stopped --network container:agt-app --memory 64m \
      -v "$DIR/app:/chain:ro" --env-file "$DIR/bridge.env" -e CMT_RPC=http://127.0.0.1:26657 \
      node:22-alpine node /chain/abci/relay-bridge.js >/dev/null
  fi
  echo "agt-2 caretaker node up on this server · P2P :26656 public · RPC localhost:26657"
elif [ "$cmd" = down ]; then
  down; echo "stopped (data kept in $DIR)"
else
  curl -s localhost:26657/status | sed -n 's/.*"network":"\([^"]*\)".*"latest_block_height":"\([0-9]*\)".*/\1 · height \2/p'
fi
