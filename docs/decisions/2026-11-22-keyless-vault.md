# The Kho: coins remain, and nobody can take them out (founder + Claude + Codex, 22 Nov 2026)

The founder: "Kho là tồn tại và không ai lấy được; đốt là tiêu hủy." The Kho keeps coins; it does not burn them.
The terms are in TU-NGU.md.

## Per chain

- **EVM chains (Ethereum, BNB Smart Chain, …).** `contracts/KeylessVault.sol`: no owner, no withdrawal, no
  transfer, no upgrade, no selfdestruct. Its only function is `deposit(beneficiary)`, or a plain send whose
  calldata is the 20-byte agt-1 account.
  - A deposit without an account is refused, and the coins stay with the sender. Nobody guesses a recipient.
  - Codex: a contract whose code has no way out is provable by reading the code. An address merely derived from a
    hash is not a proof, so it is not used.
  - The contract is deployed with CREATE2 and a published salt, so anyone can recompute its address.
- **Bitcoin.** A Taproot output to a NUMS key, derived publicly from the string "AGT-VAULT-v1:bitcoin", with no
  script path.
  - The coins stay visible as a UTXO. Spending them would mean breaking the same cryptography that protects every
    bitcoin; Codex says that plainly.
  - Not OP_RETURN: that burns.

## Minting on agt-1 (to build next)

- An agt-1 transaction carries the origin-chain transaction and its proof.
- Every validator verifies it against its own view of that chain, never trusting one RPC alone, after enough
  confirmations.
- Each deposit is credited once, by its id: chain + transaction + output/log index.
- The value in gold at the deposit is the median of independent signed price feeds, with a quorum and bounded
  staleness.
- ERC-20 deposits only through a fixed adapter, for allow-listed tokens.

## Work-mint caps

They are tied again to the AGT minted for Kho deposits: lifetime ≤ 100 + vaultMinted/19, and per day
≤ 1 + vaultMinted/3650.

## What the caretaker can do

It relays proofs and proposes. It cannot make an invalid deposit valid. What remains a dependency: the origin
chain's own consensus, the agt-1 validators, and the quorum of price feeds.

## Raw answer

docs/decisions/2026-11-22-keyless-vault-codex.md
