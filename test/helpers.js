// Self-found jobs are reviewed only by randomly drawn verifiers (audit F-2). Tests call this after submitSelf.
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

async function drawFor(work, id) {
  await mine(3); // past the seed block (DRAW_DELAY = 2)
  const r = await (await work.drawReviewers(id)).wait();
  for (const l of r.logs) {
    try {
      const e = work.interface.parseLog(l);
      if (e && e.name === "ReviewersDrawn") return e.args.licences.map(Number);
    } catch {}
  }
  return [];
}

module.exports = { drawFor };
