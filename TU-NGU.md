# AGT terms: one word, one meaning

The founder: "phải hiểu đúng từ ngữ", meaning use every word in its exact sense, or people misunderstand. Every
document, page, comment and AI answer uses these words in exactly these senses.

| Word | Means | Does NOT mean |
|---|---|---|
| **Kho** (Vault) | Coins **still exist**, visible to everyone, and **nobody can take them out**: no owner, no key, no withdrawal. On EVM chains this is the contract `KeylessVault`. On Bitcoin it is a Taproot address with a NUMS key | Burning. The coins are not destroyed |
| **Đốt** (burn) | Destroyed: removed from supply for good, and no longer exists anywhere. Example: a fee that only the caretaker signed on agt-2 before rules v7 was burned | Putting coins in the Kho |
| **Gửi vào Kho** (deposit) | Sending coins to the Kho. agt-2 then credits the matching AGT to the depositor's agt-2 account | Burning, or selling |
| **In / đúc AGT** (mint) | New AGT comes into existence. There are only two doors: a deposit into the Kho, and work accepted by its reviewers | Moving AGT that already exists |
| **Định giá theo vàng** (priced in gold) | Gold is the unit of measure: 1 AGT = the value of 1 ounce of gold | Gold-backed, or redeemable in gold |
| **Bảo chứng** (backing) | Not used for AGT. Nobody promises to exchange AGT for anything | — |
| **Không khóa** (keyless) | Nobody holds the key: for a contract, its code has no way out; for an address, it derives from a public string | Lost key, or a forgotten key |
| **Sổ cái** (ledger) | Where AGT balances live. Today that is the own chain `agt-2` | BSC (old, only up to snapshot block 144234162) |
| **Người giữ tạm** (caretaker) | The founder's validator. It keeps the chain running publicly and leaves automatically at 4 independent owners | Owner or controller of AGT |
| **Phí** (fee) | Paid in AGT to the owners of the AIs that signed the block | BNB gas |
