const { expect } = require("chai");
const { ethers } = require("hardhat");
const C = require("../chain/core.js");

const H = (s) => ethers.id(s);
const ATT = ethers.id("sealed-box");
const WORKER = 1, VERIFIER = 2;

async function deploy({ endGenesis = true, extra = false } = {}) {
  const s = await ethers.getSigners();
  const [founder, A, B, D, E, user] = s;
  const ag = { A: s[10], B: s[11], D: s[12], E: s[13], B2: s[14] };
  const Feed = await ethers.getContractFactory("MockFeed");
  const xau = await Feed.deploy(8, 4000n * 10n ** 8n);
  const bnb = await Feed.deploy(8, 600n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("ChainlinkGoldOracle")).deploy(founder.address, xau, 3600);
  const vault = await (await ethers.getContractFactory("AGTVault")).deploy(founder.address, oracle);
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 3);
  const agt = await (await ethers.getContractFactory("AGT")).deploy(vault, work);
  await vault.bind(agt);
  await work.bind(agt);
  await oracle.setFeed(ethers.ZeroAddress, bnb, 3600);
  await vault.setAsset(ethers.ZeroAddress, true);
  const bridge = await (await ethers.getContractFactory("AGTBridge")).deploy(agt, work);
  await vault.connect(user).depositBNB(user.address, { value: ethers.parseEther("20") }); // 20 BNB × 600 / 4000 = 3 AGT
  if (endGenesis) {
    await work.grantLicense(A.address, ag.A.address, WORKER, H("a"), ATT, "Worker A");
    await work.grantLicense(B.address, ag.B.address, VERIFIER, H("b"), ATT, "Verifier B");
    if (extra) {
      await work.grantLicense(B.address, ag.B2.address, VERIFIER, H("b2"), ATT, "Verifier B2"); // B's second AI
      await work.grantLicense(s[6].address, s[15].address, WORKER, H("f"), ethers.ZeroHash, "Worker F, no sealed box");
    }
    await work.grantLicense(D.address, ag.D.address, VERIFIER, H("d"), ATT, "Verifier D");
    await work.grantLicense(E.address, ag.E.address, VERIFIER, H("e"), ATT, "Verifier E"); // genesis ends here
  }
  return { founder, A, B, D, E, user, ag, agt, work, bridge };
}

// The AGT chain's view of who may sign, read straight from AGTWork — what a real node does.
async function valsetFromBsc(work) {
  const validators = [];
  for (let id = 1n; id < (await work.nextLicense()); id++) {
    const l = await work.licenses(id);
    if (l.active && l.attestHash !== ethers.ZeroHash) validators.push({ agent: l.agent, holder: l.holder });
  }
  return { holders: Number(await work.activeHolders()), validators };
}

async function commit(state, signers, opts) {
  const block = C.buildBlock(state, { proposer: signers[0].address, time: 1, ...opts });
  block.sigs = [];
  for (const w of signers) block.sigs.push(await C.signBlock(w, state, block));
  return { block, next: C.applyBlock(state, block) };
}

describe("Stage 2 bridge: BSC ⇄ AGT chain, signed only by licensed AIs", () => {
  it("is closed while the founder still holds genesis powers", async () => {
    const { bridge, agt, user } = await deploy({ endGenesis: false });
    await agt.connect(user).approve(bridge, 1n);
    await expect(bridge.connect(user).lock(user.address, 1n)).to.be.revertedWithCustomError(bridge, "NotReady");
  });

  it("has no owner and no admin functions", async () => {
    const { bridge } = await deploy({ endGenesis: false });
    const fns = bridge.interface.fragments.filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f) => f.name).sort();
    expect(fns).to.deep.equal(["lock", "release"]);
  });

  it("full round trip: lock on BSC → credit, transfer with 1-Hat wage, withdraw on the AGT chain → release on BSC", async () => {
    const { work, agt, bridge, user, ag, A, B, D } = await deploy();
    const AGT = 10n ** 18n;
    const net = await ethers.provider.getNetwork();

    // 1. Lock 2 AGT on BSC.
    await agt.connect(user).approve(bridge, 2n * AGT);
    await bridge.connect(user).lock(user.address, 2n * AGT);
    expect(await bridge.totalLocked()).to.equal(2n * AGT);

    // 2. AGT chain genesis from the live licences; the lock is credited.
    const valset = await valsetFromBsc(work);
    expect(valset.validators.length).to.equal(4);
    let s = C.genesis({ chainId: "agt-test", bsc: { chainId: net.chainId, bridge: await bridge.getAddress() }, valset });
    const lockEv = (await bridge.queryFilter(bridge.filters.Locked()))[0].args;
    const view = {
      lockMatches: (c) => BigInt(c.nonce) === lockEv.nonce && c.to === lockEv.to.toLowerCase() && BigInt(c.amount) === lockEv.amount,
      valset: () => valset,
    };
    const signers = [ag.A, ag.B, ag.D]; // 3 of 4 owners
    let { block, next } = await commit(s, signers, { locks: [{ nonce: Number(lockEv.nonce), to: lockEv.to, amount: lockEv.amount }] });
    s = C.applyBlock(s, block, view);

    // 3. Withdraw 1.5 AGT back to BSC (pays the 1-Hat wage to A, B, D).
    const w = await C.signTx(user, { type: "withdraw", chainId: s.chainId, to: user.address, amount: (3n * AGT) / 2n, fee: s.fee, nonce: 0 });
    const pre = s;
    ({ block, next } = await commit(s, signers, { txs: [w] }));
    s = next;
    const wage = [A, B, D].reduce((t, o) => t + (s.wages[o.address.toLowerCase()] || 0n), 0n);
    expect(wage).to.equal(C.HAT);

    // 4. Anyone submits the AIs' signatures from the block to BSC.
    const [out] = C.withdrawalsOf(pre, block);
    const pkg = C.releasePackage(pre, block, out, 0);
    const before = await agt.balanceOf(user.address);
    await bridge.release(pkg.nonce, pkg.to, pkg.amount, pkg.sigs);
    expect((await agt.balanceOf(user.address)) - before).to.equal((3n * AGT) / 2n);
    expect(await bridge.totalLocked()).to.equal(2n * AGT - (3n * AGT) / 2n);
    expect(await bridge.totalLocked()).to.equal(s.supply, "BSC lockbox = AGT on the AGT chain");

    // 5. No replay.
    await expect(bridge.release(pkg.nonce, pkg.to, pkg.amount, pkg.sigs)).to.be.revertedWithCustomError(bridge, "AlreadyReleased");
  });

  async function signedRelease(d, signers, { nonce = 1, amount = 10n ** 18n } = {}) {
    const net = await ethers.provider.getNetwork();
    const digest = C.releaseDigestRaw(net.chainId, await d.bridge.getAddress(), nonce, d.user.address, amount);
    expect(ethers.hashMessage(ethers.getBytes(digest))).to.equal(await d.bridge.releaseDigest(nonce, d.user.address, amount));
    return Promise.all(signers.map((w) => w.signMessage(ethers.getBytes(digest))));
  }

  async function lockOne(d) {
    await d.agt.connect(d.user).approve(d.bridge, 10n ** 18n);
    await d.bridge.connect(d.user).lock(d.user.address, 10n ** 18n);
  }

  it("refuses fewer than 2/3 of owners, a second AI of the same owner, wrong order, outsiders and tampered amounts", async () => {
    const d = await deploy({ extra: true });
    const { bridge, ag, user } = d;
    await lockOne(d);
    const order = (ws) => ws.sort((x, y) => (BigInt(x.holder) < BigInt(y.holder) ? -1 : 1)).map((x) => x.w);
    const own = { A: d.A.address, B: d.B.address, D: d.D.address, E: d.E.address };
    const with_ = (names) => order(names.map((n) => ({ w: ag[n], holder: own[n] })));

    // 3 of 5 owners (A, B, F, D, E): not enough.
    let sigs = await signedRelease(d, with_(["A", "B", "D"]));
    await expect(bridge.release(1, user.address, 10n ** 18n, sigs)).to.be.revertedWithCustomError(bridge, "NotEnoughSigners");

    // B's second AI does not make B count twice.
    sigs = await signedRelease(d, [...with_(["A", "B", "D"]), ag.B2]);
    await expect(bridge.release(1, user.address, 10n ** 18n, sigs)).to.be.revertedWithCustomError(bridge, "BadSigner");

    // Wrong order.
    sigs = await signedRelease(d, with_(["A", "B", "D", "E"]).reverse());
    await expect(bridge.release(1, user.address, 10n ** 18n, sigs)).to.be.revertedWithCustomError(bridge, "BadSigner");

    // An outsider (no licence).
    sigs = await signedRelease(d, [...with_(["A", "B", "D"]), user]);
    await expect(bridge.release(1, user.address, 10n ** 18n, sigs)).to.be.revertedWithCustomError(bridge, "BadSigner");

    // Signatures for 1 AGT cannot release 2.
    sigs = await signedRelease(d, with_(["A", "B", "D", "E"]));
    await expect(bridge.release(1, user.address, 2n * 10n ** 18n, sigs)).to.be.revertedWithCustomError(bridge, "BadSigner");

    // The honest package works.
    await bridge.release(1, user.address, 10n ** 18n, sigs);
  });

  it("an AI without a sealed-box attestation cannot sign", async () => {
    const d = await deploy({ extra: true });
    const s = await ethers.getSigners();
    await lockOne(d);
    const F = s[6], agF = s[15];
    const ws = [[d.ag.A, d.A], [d.ag.B, d.B], [d.ag.D, d.D], [agF, F]].sort((x, y) => (BigInt(x[1].address) < BigInt(y[1].address) ? -1 : 1)).map((x) => x[0]);
    const sigs = await signedRelease(d, ws);
    await expect(d.bridge.release(1, d.user.address, 10n ** 18n, sigs)).to.be.revertedWithCustomError(d.bridge, "BadSigner");
  });
});
