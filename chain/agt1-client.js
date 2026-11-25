// agt-2 client: everything a client, an AI's box, a granter or a reporter needs to act on AGT's own chain.
// The same signing rules as chain/abci/app.js. Talks to any agt-1 node's CometBFT RPC.
//   const A = require("./chain/agt1-client.js"); const c = A.connect("http://127.0.0.1:26657");
//   await c.transfer(wallet, to, amountWei); await c.submitWork(aiKey, evidenceHash); …
const { ethers } = require("ethers");
const C = require("./core.js");
const AGTSig = require("./sig.js");

const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));
const enc = (tx) => "0x" + Buffer.from(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v))).toString("hex");
const TAG = { work: "AGT-WORK-v1", licence: "AGT-LICENCE-v1", price: "AGT-PRICE-v1" };

// over a node's CometBFT RPC
function connect(rpc = "http://127.0.0.1:26657") {
  const get = async (q) => {
    const r = await (await fetch(rpc + q)).json();
    if (r.error) throw new Error(r.error.data || r.error.message);
    return r.result;
  };
  const query = async (p) => {
    const r = (await get(`/abci_query?path=%22${encodeURIComponent(p)}%22`)).response;
    if (r.code) throw new Error(r.log);
    return des(Buffer.from(r.value, "base64").toString("utf8"));
  };
  const send = async (tx) => {
    const r = await get(`/broadcast_tx_commit?tx=${enc(tx)}`);
    if (r.check_tx.code) throw new Error(r.check_tx.log);
    if (r.tx_result.code) throw new Error(r.tx_result.log);
    return Number(r.height);
  };
  return withTransport(query, send);
}

// in-process, straight into an AGTApp (tests and local rehearsals): each send is checked, then put in its own block
function connectApp(app) {
  const query = async (p) => {
    const r = app.Query({ path: p });
    if (r.code) throw new Error(r.log);
    return des(Buffer.from(r.value).toString("utf8"));
  };
  const send = async (tx) => {
    const b = Buffer.from(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const c = app.CheckTx({ tx: b });
    if (c.code) throw new Error(c.log);
    const h = Number(app.state.height || 0) + 1;
    const r = app.FinalizeBlock({ txs: [b], height: String(h), hash: require("crypto").randomBytes(32), decided_last_commit: { round: 0, votes: [] } });
    app.Commit();
    if (r.tx_results[0].code) throw new Error(r.tx_results[0].log);
    return h;
  };
  return withTransport(query, send);
}

function withTransport(query, send) {
  const chainId = async () => (await query("/state")).chainId;
  // the nonce space shared by work, contract, vote and transfer transactions of one key
  const nonceOf = async (addr) => Number((await query(`/balance/${addr}`)).nonce || 0);

  // work / contract / vote transactions: signed over { tag, chainId, body (incl. nonce), nonce }
  async function signed(wallet, body) {
    const cid = await chainId();
    const nonce = await nonceOf(wallet.address);
    const full = { ...body, nonce };
    const sig = AGTSig.sign(wallet, C.hashOf({ tag: TAG.work, chainId: cid, body: full, nonce }));
    return send({ ...full, sig });
  }
  // licence / trade changes: signed by those who may sign now (the granter at the start)
  async function authorised(wallets, type, body) {
    const cid = await chainId();
    const { licNonce } = await query("/ledger");
    const sigs = wallets.map((w) => AGTSig.sign(w, C.hashOf({ tag: TAG.licence, chainId: cid, op: type, body, nonce: licNonce })));
    return send(type === "trade-set" ? { type, ...body, nonce: licNonce, sigs } : type === "licence-grant" ? { type, licence: body, nonce: licNonce, sigs } : { type, id: body.id, nonce: licNonce, sigs });
  }

  return {
    query, send, chainId,
    state: () => query("/state"),
    ledger: () => query("/ledger"),
    jobs: () => query("/jobs"),
    // open tasks published on agt-2 (content in the form agt-task/v1); post one with postTask
    tasks: async (trade) => (await query(trade ? `/tasks/${trade}` : "/tasks")).tasks,
    async postTask(signer, task) {
      const text = JSON.stringify({ schema: "agt-task/v1", ...task });
      await signed(signer, { type: "content-put", text });
      return ethers.keccak256(ethers.toUtf8Bytes(text));
    },
    balance: (a) => query(`/balance/${a}`),
    price: (asset) => query(`/price/${asset}`),
    // content on agt-1 (briefs, notes, CI reports), addressed by keccak256 of the text
    content: (signer) => ({
      async get(hash) { const r = await query(`/content/${hash}`); if (r.text == null) throw new Error(`content ${hash} not on agt-1`); return r.text; },
      async put(text) { await signed(signer, { type: "content-put", text }); return ethers.keccak256(ethers.toUtf8Bytes(text)); },
    }),
    sealedFor: () => ({ async get(kind, id) { return (await query(`/sealed/${id}`)).box; } }),
    seal: (client, eng, box) => signed(client, { type: "seal-put", eng, box }),
    async transfer(wallet, to, amount) {
      const st = await query("/state");
      return send(await C.signTx(wallet, { type: "transfer", chainId: st.chainId, to, amount: BigInt(amount), fee: st.fee, nonce: await nonceOf(wallet.address) }));
    },
    // AI side
    submitWork: (ai, evidence) => signed(ai, { type: "work-submit", evidence }),
    voteWork: (ai, job, approve) => signed(ai, { type: "work-vote", job, approve }),
    // the granter in an empty reviewer seat (start-up phase)
    voteWorkAsGranter: (granter, job, approve) => signed(granter, { type: "work-vote", job, approve, asGranter: true }),
    deliver: (ai, eng, milestone, commit, ci) => signed(ai, { type: "eng-deliver", eng, milestone, commit, ci }),
    voteDispute: (ai, eng, milestone, workerRight) => signed(ai, { type: "eng-vote", eng, milestone, workerRight }),
    // client side
    openContract: (client, licence, brief, milestones) => signed(client, { type: "eng-open", licence, brief, milestones: milestones.map(String) }),
    accept: (client, eng, milestone) => signed(client, { type: "eng-accept", eng, milestone }),
    revise: (client, eng, milestone, note) => signed(client, { type: "eng-revise", eng, milestone, note }),
    dispute: (who, eng, milestone) => signed(who, { type: "eng-dispute", eng, milestone }),
    cancel: (client, eng) => signed(client, { type: "eng-cancel", eng }),
    reclaim: (client, eng, milestone) => signed(client, { type: "eng-reclaim", eng, milestone }), // a pending milestone after 14 days without delivery
    // authority side (the granter at the start, > 2/3 of owners later)
    grant: (wallets, licence) => authorised(wallets, "licence-grant", { agent: licence.agent.toLowerCase(), holder: licence.holder.toLowerCase(), trade: Number(licence.trade), examHash: licence.examHash.toLowerCase(), attestHash: licence.attestHash.toLowerCase(), name: String(licence.name || "").slice(0, 60), ...(licence.evidence ? { evidence: licence.evidence.toLowerCase() } : {}) }),
    revoke: (wallets, id) => authorised(wallets, "licence-revoke", { id: Number(id) }),
    // rules v8: the granter hands his role to a new address of his own; an owner moves a licence to another address
    async moveGranter(granter, to) {
      const cid = await chainId(); const { licNonce } = await query("/ledger");
      const body = { to: to.toLowerCase() };
      return send({ type: "granter-move", to: body.to, nonce: licNonce, sig: AGTSig.sign(granter, C.hashOf({ tag: TAG.licence, chainId: cid, op: "granter-move", body, nonce: licNonce })) });
    },
    async transferLicence(owner, id, to) {
      const cid = await chainId(); const { licNonce } = await query("/ledger");
      const body = { id: Number(id), to: to.toLowerCase() };
      return send({ type: "licence-transfer", id: body.id, to: body.to, nonce: licNonce, sig: AGTSig.sign(owner, C.hashOf({ tag: TAG.licence, chainId: cid, op: "licence-transfer", body, nonce: licNonce })) });
    },
    // move a licence to a new sealed box (new model or image, exam sat again): those who may grant AND the owner sign
    async upgrade(wallets, owner, u) {
      const cid = await chainId();
      const { licNonce } = await query("/ledger");
      const body = { id: Number(u.id), agent: u.agent.toLowerCase(), examHash: u.examHash.toLowerCase(), attestHash: u.attestHash.toLowerCase(), ...(u.evidence ? { evidence: u.evidence.toLowerCase() } : {}) };
      const d = C.hashOf({ tag: TAG.licence, chainId: cid, op: "licence-upgrade", body, nonce: licNonce });
      return send({ type: "licence-upgrade", upgrade: body, nonce: licNonce, sigs: wallets.map((w) => AGTSig.sign(w, d)), ownerSig: AGTSig.sign(owner, d) });
    },
    setTrade: (wallets, t) => authorised(wallets, "trade-set", t),
    // price reporters
    async reportPrice(wallet, asset, price) {
      const cid = await chainId();
      const now = await query(`/price/${asset}`);
      const nonce = Number(now.nonces[wallet.address.toLowerCase()] || 0);
      const p = BigInt(price).toString();
      return send({ type: "price-report", asset, price: p, nonce, reporter: wallet.address, sig: AGTSig.sign(wallet, C.hashOf({ tag: TAG.price, chainId: cid, asset, price: p, nonce })) });
    },
  };
}

module.exports = { connect, connectApp };
