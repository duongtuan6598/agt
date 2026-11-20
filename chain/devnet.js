// In-process devnet: 4 licensed AIs (4 owners) take turns proposing; a block is final once
// AIs of > 2/3 of the owners sign it. One AI goes offline half-way — the chain keeps going.
//   node chain/devnet.js
// Toy networking only; the rules live in core.js. Production runs core.js as a CometBFT app.
const { ethers } = require("ethers");
const C = require("./core.js");

const W = (s) => new ethers.Wallet(ethers.id("agt-devnet-" + s));
const fmt = (wei) => `${(Number(wei / 10n ** 6n) / 1e12).toFixed(6)} AGT`;
const hat = (wei) => `${(Number(wei) / 1e12).toLocaleString("en-US")} Hat`;

async function main() {
  const ais = ["Atlas", "Borealis", "Cygnus", "Draco"].map((n) => ({ name: n, key: W("ai-" + n), owner: W("owner-" + n), online: true }));
  const valset = { holders: ais.length, validators: ais.map((a) => ({ agent: a.key.address, holder: a.owner.address })) };
  const bsc = { chainId: 97, bridge: "0x000000000000000000000000000000000000b51d" };
  // A stand-in for the BSC lockbox: two people lock AGT, the validators see the Locked events.
  const locks = [];
  const alice = W("alice"), bob = W("bob");
  locks.push({ nonce: 1, to: alice.address, amount: 10n ** 18n });
  locks.push({ nonce: 2, to: bob.address, amount: 5n * 10n ** 17n });
  const bscView = { lockMatches: (c) => locks.some((l) => l.nonce === c.nonce && l.to.toLowerCase() === c.to && l.amount === BigInt(c.amount)), valset: () => valset };

  let s = C.genesis({ chainId: "agt-devnet-1", bsc, valset });
  const mempool = [];
  const nonce = {};
  const send = async (w, tx) => {
    const n = nonce[w.address] || 0;
    nonce[w.address] = n + 1;
    mempool.push(await C.signTx(w, { chainId: s.chainId, fee: s.fee, nonce: n, ...tx }));
  };

  console.log(`AGT chain devnet · ${ais.length} AIs / ${valset.holders} owners · a block needs > 2/3 of owners · wage ${hat(s.fee)} per tx (ceiling ${hat(C.MAX_FEE)})\n`);
  for (let h = 1; h <= 8; h++) {
    if (h === 2) {
      await send(alice, { type: "transfer", to: bob.address, amount: 25n * 10n ** 16n });
      await send(bob, { type: "transfer", to: alice.address, amount: 10n ** 15n });
    }
    if (h === 4) {
      ais[3].online = false;
      console.log("   ⚡ Draco goes offline");
    }
    if (h === 5) await send(alice, { type: "withdraw", to: alice.address, amount: 10n ** 17n });
    if (h === 6) for (let i = 0; i < 3; i++) await send(bob, { type: "transfer", to: alice.address, amount: 10n ** 12n });

    const online = ais.filter((a) => a.online);
    const proposer = online[h % online.length];
    const block = C.buildBlock(s, { proposer: proposer.key.address, time: h, txs: mempool.splice(0), locks });
    block.sigs = [];
    for (const a of online) {
      // Each AI checks the block against its own view of the rules and BSC before signing.
      try {
        C.applyBlock(s, { ...block, sigs: [] }, bscView);
      } catch (e) {
        if (!/not enough signers/.test(e.message)) continue; // refuses an invalid block
      }
      block.sigs.push(await C.signBlock(a.key, s, block));
    }
    const pre = s;
    s = C.applyBlock(s, block, bscView);
    const what = [
      block.credits.length && `${block.credits.length} credit(s) from BSC`,
      block.txs.length && `${block.txs.length} tx`,
    ].filter(Boolean).join(", ") || "empty";
    console.log(`#${s.height}  proposer ${proposer.name.padEnd(8)}  signed by ${block.sigs.length}/${ais.length}  ${what}`);
    for (const w of C.withdrawalsOf(pre, block)) {
      const pkg = C.releasePackage(pre, block, w, 0);
      console.log(`     ↳ withdrawal #${pkg.nonce}: ${fmt(pkg.amount)} → BSC, ${pkg.sigs.length} AI signatures ready for AGTBridge.release()`);
    }
  }

  console.log("\nConsensus wage earned (100% to the owners whose AIs signed):");
  for (const a of ais) console.log(`  ${a.name.padEnd(9)} owner ${a.owner.address.slice(0, 10)}…  ${hat(s.wages[a.owner.address.toLowerCase()] || 0n)}`);
  const total = Object.values(s.balances).reduce((t, v) => t + v, 0n);
  console.log(`\nSupply on the AGT chain: ${fmt(s.supply)} (= locked on BSC − withdrawn) · sum of balances ${fmt(total)} · ${total === s.supply ? "✓ nothing minted" : "✗ MISMATCH"}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
