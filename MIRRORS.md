# Mirrors: AGT does not live in one place

The site and the code are addressed by content on IPFS. Anyone with the CID can fetch them, check them, and pin
them again. Pinata pins them today, as one pin among any number. Public gateways throttle; an IPFS node does not.

| What | CID (IPFS) | How to use |
|---|---|---|
| Site (`public/`), 22 Nov 2026 | `bafybeibj7bi7irk3cqsnvn6mwjuqy4svrv75oqmyrn4lm53rtpgxxfkksu` | `ipfs get <cid>`, then open `hire.html` or `llms.txt` |
| Code (git bundle of `main`, commit 2f4e4fc) | `bafybeiellnzx5urj2vxxzmid3bnd2wtzlbxbvfj2toozwkzutprylyrs7q` | `ipfs get <cid> -o agt.bundle && git clone agt.bundle agt` |

The chain needs none of these hosts:
- anyone with the genesis (`chain/genesis/agt-1.json`, also inside both mirrors) can run an agt-1 node;
- the public RPC door (`relay-worker/`) is one door among any number that anyone can run.

New mirrors are added here with their CID; old rows stay.
