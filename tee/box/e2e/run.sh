#!/usr/bin/env bash
# Local end-to-end of key escrow: 2 peer boxes + box A; A "restarts" on the same instance and gets its keys back;
# a box on another instance asks for A's keys and gets nothing.
set -u
export MSYS_NO_PATHCONV=1
E2E="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
cd /c/DuongTuan/agt
NET=agt-e2e
cleanup() { docker rm -f l-p1 l-p2 l-a l-x p1 p2 boxa boxa2 boxx store >/dev/null 2>&1; for v in v-p1 v-p2 v-a v-x; do docker volume rm $v >/dev/null 2>&1; done; docker network rm $NET >/dev/null 2>&1; }
cleanup
node -e '
const c=require("crypto"),fs=require("fs");const {publicKey,privateKey}=c.generateKeyPairSync("rsa",{modulusLength:2048});
fs.writeFileSync(process.argv[1]+"/test-key.pem",privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync(process.argv[1]+"/test-jwks.json",JSON.stringify([{...publicKey.export({format:"jwk"}),kid:"test",alg:"RS256"}]));' "$E2E"
docker build -q -f tee/box/Dockerfile -t agt-box:dev . >/dev/null
printf 'FROM agt-box:dev\nCOPY test-jwks.json /agt/tee/test-jwks.json\n' > "$E2E/Dockerfile.test"
docker build -q -f "$E2E/Dockerfile.test" -t agt-box:test "$E2E" >/dev/null
DIGEST=$(docker inspect --format '{{.Id}}' agt-box:test)
echo "test image $DIGEST"
docker network create $NET >/dev/null

launcher() { docker volume create v-$1 >/dev/null; docker run -d --name l-$1 -e IMAGE_DIGEST=$DIGEST -e INSTANCE=$2 -v v-$1:/run/container_launcher -v "$E2E:/keys:ro" -v "$E2E/fake-launcher.js:/fl.js:ro" node:20-alpine node /fl.js >/dev/null; }
box() { local name=$1 vol=$2; shift 2; docker run -d --name $name --hostname $name --network $NET -v v-$vol:/run/container_launcher "$@" agt-box:test >/dev/null; }

launcher p1 201; launcher p2 202; launcher a 111; launcher x 999
sleep 2
box p1 p1; box p2 p2
sleep 4
box boxa a -e AGT_PEER_BOXES=http://p1:8080,http://p2:8080
sleep 6
echo "--- box A, first boot"
docker logs boxa 2>&1 | grep -E "AI licence key|escrowed|escrow not made|FATAL" | cut -c26-200
AGENT_A=$(docker logs boxa 2>&1 | grep -o "AI licence key 0x[0-9a-fA-F]*" | head -1 | awk '{print $4}')
docker logs boxa 2>&1 | grep -o 'AGT_ESCROW {.*}' | sed 's/^AGT_ESCROW //' > "$E2E/record.json"
echo "record: $(wc -c < "$E2E/record.json") bytes of ciphertext, kept by the owner"
docker run -d --name store --hostname store --network $NET -v "$E2E/record.json:/r.json:ro" node:20-alpine node -e 'require("http").createServer((q,s)=>s.end(require("fs").readFileSync("/r.json"))).listen(80)' >/dev/null

echo "--- box A crashes; the VM restarts (same instance 111)"
docker rm -f boxa >/dev/null
box boxa2 a -e AGT_PEER_BOXES=http://p1:8080,http://p2:8080 -e AGT_ESCROW_URL=http://store/
sleep 7
docker logs boxa2 2>&1 | grep -E "share|recovered|AI licence key|FATAL" | cut -c26-200
AGENT_A2=$(docker logs boxa2 2>&1 | grep -o "AI licence key 0x[0-9a-fA-F]*" | head -1 | awk '{print $4}')
[ -n "$AGENT_A" ] && [ "$AGENT_A" = "$AGENT_A2" ] && echo "✓ SAME AI KEY after restart: $AGENT_A" || echo "✗ keys differ ($AGENT_A vs $AGENT_A2)"

echo "--- another VM (instance 999), same image, asks for A's keys"
box boxx x -e AGT_PEER_BOXES=http://p1:8080,http://p2:8080 -e AGT_ESCROW_URL=http://store/
sleep 7
docker logs boxx 2>&1 | grep -E "share|recovered|FATAL" | cut -c26-200
cleanup
echo "cleaned"
