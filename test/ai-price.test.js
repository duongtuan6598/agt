// Sealed AIs as a price source (Charter Art. 11/13, audit F-3): AIs of 3 owners read public markets (faked here),
// sign the rounded median, a collector gathers the signatures, and the feed records the price once AIs of
// > 2/3 of council owners agree. MedianGoldOracle then uses it next to Chainlink.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { AgentLoop, WORK_ABI } = require("../tee/box/agent.js");
const P = require("../tee/box/prices.js");

const ATT = ethers.id("sealed-box");
const XAU = "0x0000000000000000000000000000000000000001";

// Fake markets: every URL answers with the same shape the real venue uses, at the given price.
function markets(gold) {
  return async (url) => ({
    json: async () => {
      if (url.includes("coinbase")) return { data: { amount: String(gold) } };
      if (url.includes("kraken")) return { result: { X: { c: [String(gold)] } } };
      if (url.includes("binance")) return { price: String(gold) };
      if (url.includes("okx")) return { data: [{ last: String(gold) }] };
      if (url.includes("bitfinex")) return [0, 0, 0, 0, 0, 0, gold];
      throw new Error("unknown");
    },
  });
}
function memoryCollector() {
  const store = {};
  return {
    store,
    put: async (e) => { const k = `${e.feed}:${e.window}`; (store[k] = store[k] || {}); (store[k][e.answer] = store[k][e.answer] || []).push({ agent: e.agent, sig: e.sig }); },
    get: async (feed, w) => store[`${feed}:${w}`] || {},
  };
}

async function world({ endGenesis = true } = {}) {
  const s = await ethers.getSigners();
  const founder = s[0], owners = [s[1], s[2], s[3]], ais = [s[10], s[11], s[12]];
  const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 3);
  const n = endGenesis ? 3 : 2;
  for (let i = 0; i < n; i++) await work.grantLicense(owners[i].address, ais[i].address, 2, ethers.id("v" + i), ATT, "verifier " + i);
  const feed = await (await ethers.getContractFactory("AICouncilPriceFeed")).deploy(work, "XAU / USD", 8);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const collector = memoryCollector();
  const clock = async () => await time.latest();
  const loop = (ai, gold) => new AgentLoop({ work: new ethers.Contract(work, WORK_ABI, ai), me: ai.address, prices: { feeds: { "XAU/USD": feed.target }, chainId, collector, fetchImpl: markets(gold), clock } });
  return { work, feed, ais, owners, collector, loop, chainId, founder, s };
}

describe("AICouncilPriceFeed — sealed AIs write the price", () => {
  it("three owners' AIs agree (small differences fall in the same 10 USD step) → the price is recorded", async () => {
    const { feed, ais, loop } = await world();
    const golds = [3571.2, 3569.9, 3573.4]; // each AI sees slightly different markets
    let recorded = [];
    for (let i = 0; i < 3; i++) {
      const l = loop(ais[i], golds[i]);
      recorded = await l.priceStep(await l.licence());
    }
    expect(recorded.length).to.equal(1); // the third AI completed the quorum and relayed it
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.equal(3570n * 10n ** 8n);
  });

  it("two of three owners are not > 2/3: nothing is recorded", async () => {
    const { feed, ais, loop } = await world();
    for (let i = 0; i < 2; i++) { const l = loop(ais[i], 3570); await l.priceStep(await l.licence()); }
    expect((await feed.latestRoundData())[1]).to.equal(0n);
  });

  it("before genesis ends the feed is closed — the founder can never write a price", async () => {
    const { feed, chainId } = await world({ endGenesis: false });
    const w = Math.floor((await time.latest()) / 600);
    await expect(feed.submit(w, 3570n * 10n ** 8n, [])).to.be.revertedWithCustomError(feed, "NotReady");
    expect(chainId).to.be.a("number");
  });

  it("signatures from an outsider, a duplicated owner, or for another price are refused on chain", async () => {
    const { feed, ais, chainId, s } = await world();
    const w = Math.floor((await time.latest()) / 600);
    const ans = 3570n * 10n ** 8n;
    const sign = (wal, a = ans) => P.signPrice(wal, chainId, feed.target, w, a);
    // signatures must come sorted by OWNER address
    const order = [[s[1], ais[0]], [s[2], ais[1]], [s[3], ais[2]]].sort((a, b) => (BigInt(a[0].address) < BigInt(b[0].address) ? -1 : 1)).map((x) => x[1]);
    await expect(feed.submit(w, ans, [await sign(order[0]), await sign(order[1]), await sign(s[13])])).to.be.revertedWithCustomError(feed, "BadSigner");
    await expect(feed.submit(w, ans, [await sign(order[0]), await sign(order[0]), await sign(order[1])])).to.be.revertedWithCustomError(feed, "BadSigner");
    await expect(feed.submit(w, ans + 1n, await Promise.all(order.map((o) => sign(o))))).to.be.revertedWithCustomError(feed, "BadSigner");
    await feed.submit(w, ans, await Promise.all(order.map((o) => sign(o))));
    await expect(feed.submit(w, ans, await Promise.all(order.map((o) => sign(o))))).to.be.revertedWithCustomError(feed, "StaleWindow");
  });

  it("if the markets disagree by more than 1%, an AI refuses to sign at all", async () => {
    const bad = async (url) => ({ json: async () => (url.includes("coinbase") ? { data: { amount: "4000" } } : url.includes("kraken") ? { result: { X: { c: ["3570"] } } } : url.includes("binance") ? { price: "3570" } : url.includes("okx") ? { data: [{ last: "3570" }] } : [0, 0, 0, 0, 0, 0, 3570]) });
    await expect(P.observe("XAU/USD", bad)).to.be.rejectedWith(/disagree/);
  });

  it("MedianGoldOracle uses the AI-written price as a second, independent source next to Chainlink", async () => {
    const { feed, ais, loop, founder } = await world();
    for (let i = 0; i < 3; i++) { const l = loop(ais[i], 3571); await l.priceStep(await l.licence()); }
    const cl = await (await ethers.getContractFactory("MockFeed")).deploy(8, 3560n * 10n ** 8n);
    const oracle = await (await ethers.getContractFactory("MedianGoldOracle")).deploy(founder.address, 2, 200, 100);
    await oracle.setSources(XAU, [{ kind: 1, at: cl.target, id: ethers.ZeroHash, maxAge: 3600 }, { kind: 1, at: feed.target, id: ethers.ZeroHash, maxAge: 3600 }]);
    expect(await oracle.priceUSD(XAU)).to.equal(3565n * 10n ** 18n); // median of 3560 (Chainlink) and 3570 (AI council)
  });
});
