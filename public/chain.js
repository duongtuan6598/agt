// Đọc toàn bộ trạng thái AGT thẳng từ chain — không máy chủ, không trung gian.
// Chạy được cả trên trình duyệt (window.AGTChain) lẫn Node (require).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AGTChain = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const ABI = {
    agt: [
      "function totalSupply() view returns (uint256)",
      "function mintedByVault() view returns (uint256)",
      "function mintedByWork() view returns (uint256)",
      "function GENESIS() view returns (string)",
      "function SEALED() view returns (bytes32)",
      "function HAT() view returns (uint256)",
    ],
    vault: [
      "function owner() view returns (address)",
      "function frozen() view returns (bool)",
      "function assetCount() view returns (uint256)",
      "function assets(uint256) view returns (address)",
      "function accepted(address) view returns (bool)",
      "function reserve(address) view returns (uint256)",
    ],
    oracle: [
      "function owner() view returns (address)",
      "function frozen() view returns (bool)",
      "function xau() view returns (address feed, uint32 maxAge)",
      "function valueInAGT(address,uint256) view returns (uint256)",
    ],
    feed: [
      "function decimals() view returns (uint8)",
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    ],
    erc20: ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    work: [
      "function owner() view returns (address)",
      "function genesisEnded() view returns (bool)",
      "function genesisExitVerifiers() view returns (uint32)",
      "function activeHolders() view returns (uint32)",
      "function verifierHolders() view returns (uint32)",
      "function nextLicense() view returns (uint256)",
      "function nextProposal() view returns (uint256)",
      "function nextJob() view returns (uint256)",
      "function licenses(uint256) view returns (address holder, address agent, uint8 role, bool active, bytes32 examHash, bytes32 attestHash, string name)",
      "function proposals(uint256) view returns (address proposer, address target, uint64 deadline, uint32 yes, uint32 no, bool executed, bytes data, string reason)",
      "function passed(uint256) view returns (bool)",
      "function categories(uint256) view returns (uint128 reward, uint128 verifierReward, uint32 dailyCap, uint8 approvals, bool active, string name)",
      "function dailyBudget(uint256) view returns (uint32)",
      "function currentReward(uint256) view returns (uint256)",
    ],
    // để đọc nội dung đề xuất của Hội đồng
    gov: [
      "function grantLicense(address holder, address agent, uint8 role, bytes32 examHash, bytes32 attestHash, string name)",
      "function revokeLicense(uint256 id)",
      "function setCategory(uint256 id, string name, uint128 reward, uint128 verifierReward, uint32 dailyCap, uint8 approvals, bool active)",
      "function setDisputeRules(uint8 approvals, uint128 verifierReward, uint64 window)",
      "function setGovTarget(address target, bool ok)",
      "function adminCall(address target, bytes data)",
      "function setAsset(address token, bool ok)",
      "function setOracle(address oracle)",
      "function setFeed(address token, address feed, uint32 maxAge)",
      "function setXauFeed(address feed, uint32 maxAge)",
      "function freeze()",
      "function acceptOwnership()",
    ],
  };

  const ROLE = ["none", "worker", "verifier"];
  const ZERO = "0x0000000000000000000000000000000000000000";

  async function pickProvider(ethers, rpcs, chainId) {
    let last;
    for (const url of rpcs) {
      try {
        const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
        await p.getBlockNumber();
        return { provider: p, rpc: url };
      } catch (e) {
        last = e;
      }
    }
    throw new Error("Không kết nối được RPC nào: " + (last && (last.shortMessage || last.message)));
  }

  async function readAll(ethers, provider, cfg) {
    const c = cfg.contracts;
    const agt = new ethers.Contract(c.AGT, ABI.agt, provider);
    const vault = new ethers.Contract(c.AGTVault, ABI.vault, provider);
    const oracle = new ethers.Contract(c.ChainlinkGoldOracle, ABI.oracle, provider);
    const work = new ethers.Contract(c.AGTWork, ABI.work, provider);
    const fmt = (v) => ethers.formatEther(v);
    const lower = (a) => (a || "").toLowerCase();

    const [block, total, byVault, byWork, genesis, sealed, HAT] = await Promise.all([
      provider.getBlock("latest"),
      agt.totalSupply(),
      agt.mintedByVault(),
      agt.mintedByWork(),
      agt.GENESIS(),
      agt.SEALED(),
      agt.HAT(),
    ]);
    const now = Number(block.timestamp);

    // Giá vàng — chợ vàng đóng thì feed đứng giá, Kho đóng
    const xau = await oracle.xau();
    const xf = new ethers.Contract(xau.feed, ABI.feed, provider);
    const [xd, xr] = await Promise.all([xf.decimals(), xf.latestRoundData()]);
    const goldAge = now - Number(xr[3]);
    const gold = { usd: Number(xr[1]) / 10 ** Number(xd), age: goldAge, maxAge: Number(xau.maxAge), open: goldAge <= Number(xau.maxAge), feed: xau.feed };

    // Kho
    const n = Number(await vault.assetCount());
    const assets = [];
    let reserveAGT = 0n;
    let priced = true;
    for (let i = 0; i < n; i++) {
      const token = await vault.assets(i);
      const [acc, held] = await Promise.all([vault.accepted(token), vault.reserve(token)]);
      let symbol = "BNB", decimals = 18;
      if (lower(token) !== ZERO) {
        const t = new ethers.Contract(token, ABI.erc20, provider);
        [symbol, decimals] = await Promise.all([t.symbol(), t.decimals()]);
      }
      let valueAGT = null;
      if (held > 0n) {
        try {
          valueAGT = await oracle.valueInAGT(token, held);
          reserveAGT += valueAGT;
        } catch {
          priced = false;
        }
      } else valueAGT = 0n;
      assets.push({ token, symbol, accepted: acc, amount: ethers.formatUnits(held, decimals), valueAGT: valueAGT === null ? null : fmt(valueAGT) });
    }
    let bnbQuote = null;
    try {
      bnbQuote = fmt(await oracle.valueInAGT(ZERO, ethers.parseEther("1")));
    } catch {}

    const ratio = (num, den) => (den === 0n ? null : Number((num * 10000n) / den) / 100);

    // Hội đồng & giấy phép
    const [wOwner, gEnded, gExit, holders, vHolders, nextL, nextP, nextJ, vOwner, oOwner, vFrozen, oFrozen] = await Promise.all([
      work.owner(), work.genesisEnded(), work.genesisExitVerifiers(), work.activeHolders(), work.verifierHolders(),
      work.nextLicense(), work.nextProposal(), work.nextJob(), vault.owner(), oracle.owner(), vault.frozen(), oracle.frozen(),
    ]);
    const licenses = [];
    for (let i = 1; i < Number(nextL); i++) {
      const l = await work.licenses(i);
      licenses.push({ id: i, holder: l.holder, agent: l.agent, role: ROLE[Number(l.role)] || "?", active: l.active, examHash: l.examHash, attestHash: l.attestHash, name: l.name });
    }

    const gov = new ethers.Interface(ABI.gov);
    const nameOf = (a) => {
      const x = lower(a);
      if (x === lower(c.AGTWork)) return "work";
      if (x === lower(c.AGTVault)) return "vault";
      if (x === lower(c.ChainlinkGoldOracle)) return "oracle";
      return a;
    };
    const proposals = [];
    for (let i = 1; i < Number(nextP); i++) {
      const p = await work.proposals(i);
      let action = p.data;
      try {
        const tx = gov.parseTransaction({ data: p.data });
        action = `${tx.name}(${tx.args.map((v) => String(v)).join(", ")})`;
      } catch {}
      const passed = await work.passed(i);
      const deadline = Number(p.deadline);
      proposals.push({
        id: i, proposer: p.proposer, target: nameOf(p.target), action, reason: p.reason, yes: Number(p.yes), no: Number(p.no),
        executed: p.executed, passed, deadline, expired: !p.executed && now > deadline,
      });
    }

    const categories = [];
    const cats = await Promise.all(Array.from({ length: 12 }, (_, j) => work.categories(j + 1)));
    const [budgets, nows] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, (_, j) => work.dailyBudget(j + 1).catch(() => 0n))),
      Promise.all(Array.from({ length: 12 }, (_, j) => work.currentReward(j + 1).catch(() => null))),
    ]);
    for (let i = 1; i <= 12; i++) {
      const k = cats[i - 1];
      if (!k.name) continue;
      const now = nows[i - 1] === null ? k.reward : nows[i - 1];
      categories.push({ id: i, name: k.name, reward: (k.reward / HAT).toString(), dailyBudget: Number(budgets[i - 1]), priceNow: (Number((now * 1000n) / HAT) / 1000).toString(), verifierReward: (k.verifierReward / HAT).toString(), dailyCap: Number(k.dailyCap), approvals: Number(k.approvals), active: k.active });
    }

    // Chỉ trả dữ liệu — trang tự dịch sang ngôn ngữ người xem.
    const isCouncil = (a) => lower(a) === lower(c.AGTWork);
    const power = [
      { id: "agt", ok: true },
      { id: "vault", ok: isCouncil(vOwner), council: isCouncil(vOwner), owner: vOwner, frozen: vFrozen },
      { id: "oracle", ok: isCouncil(oOwner), council: isCouncil(oOwner), owner: oOwner, frozen: oFrozen },
      { id: "license", ok: gEnded, ended: gEnded, owner: wOwner, exit: Number(gExit), verifierHolders: Number(vHolders) },
      { id: "tx", ok: false },
    ];

    return {
      network: cfg.network, chainId: cfg.chainId, block: Number(block.number), time: now,
      supply: { total: fmt(total), vault: fmt(byVault), work: fmt(byWork), totalHat: (total / HAT).toString() },
      gold, bnbQuote,
      reserve: { assets, valueAGT: fmt(reserveAGT), priced, ratioTotal: ratio(reserveAGT, total), ratioVault: ratio(reserveAGT, byVault) },
      genesis, sealed,
      council: { ended: gEnded, owner: wOwner, exit: Number(gExit), holders: Number(holders), verifierHolders: Number(vHolders), jobs: Number(nextJ) - 1 },
      licenses, proposals, categories, power,
    };
  }

  return { ABI, pickProvider, readAll };
});
