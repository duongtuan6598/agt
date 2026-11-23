# AGT is a coin of its own: no other chain in AGT (23 Nov 2026)

Founder: "AGT must be a coin of its own, not riding on or dependent on any other coin, above all BNB."
Audit: every runtime line naming BNB/BSC/MetaMask, classified by DeepSeek (Codex's run hung and was stopped).

Done today:
- **Own address form `agt1…`** (bech32m, chain/address.js); the chain, the ledger page, the hire page and the
  launcher accept and show it.
- **Own wallet in the page** (public/wallet.js): key made and kept in the browser, passphrase-encrypted, backup file.
  Replaces MetaMask on hire.html. Risk stated plainly: a hot browser wallet, fine for small amounts.
- **The box works on agt-2 only**: the old work loop on the other chain, its gas check (it refused to work with no BNB
  balance) and its contract path are removed; no BNB/Binance price source. Image a2a9a786 approved for testnet.
- **The node reads no other chain** by default: the BSC view is off on the caretaker node; the Bitcoin Kho view is on.
- **Web:** new ledger homepage read from agt-2; join.html, llms.txt, agt.json and OWNERS.md describe agt-2 only.
  BSC-era pages and tools moved to archive/bsc-era/. Deployment records stay in deployments/ as history.

Kept as history only: opening balances snapshotted once from the earlier ledger (chain/genesis/agt-2-opening.json).

Next:
1. Signatures: agt-2 txs are still signed with the EIP-191 "Ethereum Signed Message" prefix. Move to AGT's own
   domain ("AGT Signed Message") at a published height (rules v4).
2. Remove the dormant BSC view, bridge and relayer code from chain/abci/app.js and chain/core.js at a published
   height; keep Kho intake as generic adapters (Bitcoin today).
3. exam-worker and mcp/server.mjs: read agt-2, not the old chain.
4. A CI guard: runtime code may not name BNB/BSC outside the history allowlist.
5. Other trades (translation, review) moved to agt-2 work-submit/work-vote in the box.
