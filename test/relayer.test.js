// End to end on a local BSC: real contracts + the AGT chain app (we play CometBFT) + the relayer.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const C = require("../chain/core.js");
const { AGTApp, bindDigest, des } = require("../chain/abci/app.js");
const R = require("../chain/relayer.js");

const ATT = ethers.id("sealed-box");
const AGT = 10n ** 18n;

async function world() {
  const s = await ethers.getSigners();
  const [founder, A, B, D, E, user, stranger, stranger2] = s;
  const ag = [s[10], s[11], s[12], s[13]];
  const owners = [A, B, D, E];
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
  for (let i = 0; i < 4; i++) await work.grantLicense(owners[i].address, ag[i].address, i === 0 ? 1 : 2, ethers.id("x" + i), ATT, "AI " + i);
  await vault.connect(user).depositBNB(user.address, { value: ethers.parseEther("20") }); // 3 AGT
  await agt.connect(user).approve(bridge, 2n * AGT);
  await bridge.connect(user).lock(user.address, 2n * AGT);

  // AGT chain app reading the REAL contracts as its BSC view.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-relay-"));
  const app = new AGTApp({ STATE_FILE: path.join(dir, "s.json"), BSC_PROVIDER: ethers.provider, WORK: await work.getAddress(), BRIDGE: await bridge.getAddress(), CONFIRMATIONS: "0" });
  const chainId = "agt-relay-test";
  const validators = [];
  for (let i = 0; i < 4; i++) {
    const pub = crypto.randomBytes(32).toString("base64");
    validators.push({ id: i + 1, agent: ag[i].address, holder: owners[i].address, pubKey: pub, bindSig: await ag[i].signMessage(ethers.getBytes(bindDigest(chainId, pub))) });
  }
  const net = await ethers.provider.getNetwork();
  app.InitChain({ chain_id: chainId, validators: [], app_state_bytes: Buffer.from(JSON.stringify({ bsc: { chainId: Number(net.chainId), bridge: await bridge.getAddress() }, holders: 4, validators })) });
  let h = 0;
  const round = async (txs = []) => {
    const p = await app.PrepareProposal({ txs, max_tx_bytes: "1048576", height: String(h + 1) });
    expect((await app.ProcessProposal({ txs: p.txs, height: String(h + 1) })).status).to.equal("ACCEPT");
    const r = app.FinalizeBlock({ txs: p.txs, height: String(++h), hash: crypto.randomBytes(32), decided_last_commit: { round: 0, votes: [] } });
    app.Commit();
    return r;
  };
  const B_ = (tx) => Buffer.from(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const agtQuery = async (p) => {
    const q = app.Query({ path: p });
    if (q.code !== 0) throw new Error(q.log);
    return des(q.value.toString());
  };
  const asRelayer = (signer) => new ethers.Contract(bridge, R.BRIDGE_ABI, signer);
  const workView = new ethers.Contract(work, R.WORK_ABI, ethers.provider);
  return { app, round, B_, agtQuery, asRelayer, workView, bridge, agt, user, stranger, stranger2, ag, chainId, net };
}

async function withdraw(w, amount) {
  await w.round(); // credits the BSC lock
  expect((await w.agtQuery(`/balance/${w.user.address}`)).balance).to.equal(2n * AGT);
  const tx = await C.signTx(w.user, { type: "withdraw", chainId: w.chainId, to: w.user.address, amount, fee: C.HAT, nonce: 0 });
  const r = await w.round([w.B_(tx)]);
  expect(r.tx_results.map((x) => x.code)).to.deep.equal([0]);
}
async function attest(w, who, amount) {
  const d = C.releaseDigestRaw(w.net.chainId, await w.bridge.getAddress(), 1, w.user.address.toLowerCase(), amount);
  const txs = [];
  for (const i of who) txs.push(w.B_({ type: "attest", nonce: 1, agent: w.ag[i].address, sig: await w.ag[i].signMessage(ethers.getBytes(d)) }));
  await w.round(txs);
}

describe("Relayer: AGT chain withdrawal → AGTBridge.release() on BSC", () => {
  it("waits for > 2/3 of owners, then anyone can relay; the AGT goes to the signed recipient; a second relayer finds it done", async () => {
    const w = await world();
    const amount = (3n * AGT) / 2n;
    await withdraw(w, amount);
    const relayer = { agt: w.agtQuery, bridge: w.asRelayer(w.stranger), work: w.workView };

    await attest(w, [0, 1], amount); // 2 of 4 owners
    expect(await R.relayOne({ ...relayer, nonce: 1 })).to.equal("waiting");

    await attest(w, [3], amount); // 3 of 4
    const before = await w.agt.balanceOf(w.user.address);
    const gasPayerBefore = await w.agt.balanceOf(w.stranger.address);
    expect(await R.relayOne({ ...relayer, nonce: 1 })).to.equal("released");
    expect((await w.agt.balanceOf(w.user.address)) - before).to.equal(amount);
    expect(await w.agt.balanceOf(w.stranger.address)).to.equal(gasPayerBefore, "the relayer gets nothing but the gas bill");

    expect(await R.relayOne({ agt: w.agtQuery, bridge: w.asRelayer(w.stranger2), work: w.workView, nonce: 1 })).to.equal("already");
    expect(await R.relayAll({ ...relayer })).to.deep.equal({ 1: "already" });
  });

  it("drops signatures BSC would refuse (no licence, duplicate owner) instead of wasting gas", async () => {
    const w = await world();
    const amount = AGT;
    await withdraw(w, amount);
    await attest(w, [0, 1, 2], amount);
    const pkg = await w.agtQuery("/release/1");
    const digest = await w.bridge.releaseDigest(1, w.user.address, amount);
    const outsider = new ethers.Wallet(ethers.id("outsider"));
    const forged = { ...pkg, sigs: [outsider.signingKey.sign(digest).serialized, ...pkg.sigs, pkg.sigs[0]] };
    const chk = await R.checkOnBsc(w.bridge, w.workView, forged);
    expect(chk.dropped.length).to.equal(1);
    expect(chk.sigs.length).to.equal(3);
    expect(chk.enough).to.equal(true);
    await w.asRelayer(w.stranger).release(pkg.nonce, pkg.to, pkg.amount, chk.sigs);
    expect(await w.bridge.released(1)).to.equal(true);
  });
});
