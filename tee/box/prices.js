// The sealed AI as a price source (Charter Art. 11 and 13): it reads several public markets (no API keys,
// no single company), takes the median, rounds it to an agreed step so that honest AIs land on the same value,
// and signs (window, price) for an AICouncilPriceFeed. Signatures are gathered at a public, untrusted place
// (the exam worker); anyone relays them on chain once AIs of > 2/3 of owners agree.
const { ethers } = require("ethers");

const get = (fetchImpl) => async (url, pick) => pick(await (await fetchImpl(url, { signal: AbortSignal.timeout(15000) })).json());
// Tokenised gold (PAXG / XAUT, 1 token = 1 troy ounce) tracks spot gold; several venues, several issuers.
const MARKETS = {
  "XAU/USD": {
    step: 10, // USD — ≈ 0.25% of the gold price: honest AIs agree, error stays far below the 2% oracle tolerance
    sources: [
      ["coinbase PAXG", "https://api.coinbase.com/v2/prices/PAXG-USD/spot", (j) => j.data.amount],
      ["kraken PAXG", "https://api.kraken.com/0/public/Ticker?pair=PAXGUSD", (j) => Object.values(j.result)[0].c[0]],
      ["binance PAXG", "https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT", (j) => j.price],
      ["okx XAUT", "https://www.okx.com/api/v5/market/ticker?instId=XAUT-USDT", (j) => j.data[0].last],
      ["bitfinex XAUT", "https://api-pub.bitfinex.com/v2/ticker/tXAUT:USD", (j) => j[6]],
      ["kraken XAUT", "https://api.kraken.com/0/public/Ticker?pair=XAUTUSD", (j) => Object.values(j.result)[0].c[0]],
    ],
  },
  "BNB/USD": {
    step: 1,
    sources: [
      ["coinbase", "https://api.coinbase.com/v2/prices/BNB-USD/spot", (j) => j.data.amount],
      ["binance", "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", (j) => j.price],
      ["kraken", "https://api.kraken.com/0/public/Ticker?pair=BNBUSD", (j) => Object.values(j.result)[0].c[0]],
      ["okx", "https://www.okx.com/api/v5/market/ticker?instId=BNB-USDT", (j) => j.data[0].last],
    ],
  },
};
const MIN_SOURCES = 3;
const MAX_SPREAD = 0.01; // the markets themselves must agree within 1%
const WINDOW = 600; // seconds — must equal AICouncilPriceFeed.WINDOW
const TAG = ethers.id("AGT-AI-PRICE-v1");

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// Median of the markets that answered, refused if too few answered or they disagree.
async function observe(feed, fetchImpl = fetch) {
  const m = MARKETS[feed];
  if (!m) throw new Error(`unknown feed ${feed}`);
  const g = get(fetchImpl);
  const got = (await Promise.all(m.sources.map(([name, url, pick]) => g(url, pick).then((v) => [name, Number(v)]).catch(() => null))))
    .filter((x) => x && Number.isFinite(x[1]) && x[1] > 0);
  if (got.length < MIN_SOURCES) throw new Error(`${feed}: only ${got.length} markets answered`);
  const vals = got.map((x) => x[1]);
  const med = median(vals);
  const spread = (Math.max(...vals) - Math.min(...vals)) / med;
  if (spread > MAX_SPREAD) throw new Error(`${feed}: markets disagree by ${(spread * 100).toFixed(2)}%`);
  return { median: med, sources: got.map((x) => x[0]), spread };
}

// Rounded to the feed's step, as an 8-decimal integer (Chainlink style).
const toAnswer = (feed, price) => BigInt(Math.round(price / MARKETS[feed].step) * MARKETS[feed].step) * 10n ** 8n;
const windowOf = (t = Math.floor(Date.now() / 1000)) => Math.floor(t / WINDOW);
function digest(chainId, feedAddress, window, answer) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address", "uint80", "int256"], [TAG, chainId, feedAddress, window, answer]));
}
async function signPrice(wallet, chainId, feedAddress, window, answer) {
  return wallet.signMessage(ethers.getBytes(digest(chainId, feedAddress, window, answer)));
}

// Group collected signatures for one window and pick a value backed by AIs of > 2/3 of council owners.
// work: AGTWork view (licenseOfAgent, licenses, councilHolders). Returns { answer, sigs } sorted by owner, or null.
async function bestQuorum(work, collected) {
  const holders = Number(await work.councilHolders());
  for (const [answer, entries] of Object.entries(collected)) {
    const byOwner = new Map();
    for (const { agent, sig } of entries) {
      const id = await work.licenseOfAgent(agent);
      if (id === 0n) continue;
      const l = await work.licenses(id);
      if (!l.active || l.attestHash === ethers.ZeroHash || l.agent.toLowerCase() !== agent.toLowerCase()) continue;
      if (!byOwner.has(l.holder)) byOwner.set(l.holder, sig);
    }
    if (holders > 0 && byOwner.size * 3 > holders * 2) {
      const sigs = [...byOwner.entries()].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).map((x) => x[1]);
      return { answer: BigInt(answer), sigs };
    }
  }
  return null;
}

module.exports = { MARKETS, WINDOW, observe, toAnswer, windowOf, digest, signPrice, bestQuorum, median };
