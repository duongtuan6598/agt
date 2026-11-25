// The founder in an empty reviewer seat, for self-found open-source work (THIET-KE-AI-TU-CHU.md): his vote is the
// checker's result and nothing else, so anyone can run this again and see the same vote.
//   node tools/agt1-review-oss.js            (AGT_FOUNDER_WALLET + AGT_FOUNDER_PASS; GITHUB_TOKEN optional)
const { ossVerdict } = require("../tee/box/agt1-work.js");
const RPC = process.env.AGT1_RPC || "https://agt1-relay.agtcoin.workers.dev/rpc";
(async () => {
  const a1 = require("../chain/agt1-client.js").connect(RPC);
  const w = await require("./founder.js").founderWallet();
  const me = w.address.toLowerCase();
  const gh = require("../tee/embedded/github.js").github({ token: process.env.GITHUB_TOKEN || null });
  const loop = { content: a1.content(w), gh };
  for (const [id, j] of Object.entries((await a1.jobs()) || {})) {
    if (j.status !== "drawn" || !(j.reviewers || []).includes(me) || me in (j.votes || {})) continue;
    let ev = null;
    try { ev = JSON.parse(await loop.content.get(j.evidence)); } catch {}
    if (!ev || ev.kind !== "oss-pr") continue;
    const v = await ossVerdict(loop, j);
    await a1.voteWorkAsGranter(w, Number(id), v.verdict === "accept");
    console.log(`job #${id}: ${v.verdict} — ${v.reason}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
