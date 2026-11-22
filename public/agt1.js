// agt-1 in the browser: the same signing rules as chain/core.js and chain/agt1-client.js, through a public door
// (or any agt-1 node's RPC). Needs window.ethers. No BSC, no outside content service.
(function (root) {
  const ethers = root.ethers;
  const DOOR = "https://agt1-relay.agtcoin.workers.dev/rpc";
  const HAT = 10n ** 12n;
  // canonical JSON, exactly as chain/core.js: keys sorted, bigint as a string, undefined dropped
  function canon(v) {
    if (typeof v === "bigint") return JSON.stringify(v.toString());
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }
  const hashOf = (v) => ethers.keccak256(ethers.toUtf8Bytes(canon(v)));
  const des = (t) => JSON.parse(t, (k, v) => (v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v));

  function connect(rpc = DOOR) {
    const get = async (q) => {
      const r = await (await fetch(rpc + q)).json();
      if (r.error) throw new Error(r.error.data || r.error.message || r.error);
      return r.result;
    };
    const query = async (p) => {
      const r = (await get(`/abci_query?path=%22${encodeURIComponent(p)}%22`)).response;
      if (r.code) throw new Error(r.log);
      const bytes = Uint8Array.from(atob(r.value), (c) => c.charCodeAt(0));
      return des(new TextDecoder().decode(bytes));
    };
    const send = async (tx) => {
      const hex = "0x" + Array.from(new TextEncoder().encode(JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v))), (b) => b.toString(16).padStart(2, "0")).join("");
      const r = await get(`/broadcast_tx_commit?tx=${hex}`);
      if (r.check_tx.code) throw new Error(r.check_tx.log);
      if (r.tx_result.code) throw new Error(r.tx_result.log);
      return Number(r.height);
    };
    const chainId = async () => (await query("/state")).chainId;
    async function signed(signer, body) {
      const me = await signer.getAddress();
      const cid = await chainId();
      const nonce = Number((await query(`/balance/${me}`)).nonce || 0);
      const full = { ...body, nonce };
      const sig = await signer.signMessage(ethers.getBytes(hashOf({ tag: "AGT-WORK-v1", chainId: cid, body: full, nonce })));
      return send({ ...full, sig });
    }
    return {
      query, send,
      state: () => query("/state"),
      ledger: () => query("/ledger"),
      engs: () => query("/engs"),
      balance: (a) => query(`/balance/${a}`),
      async content(hash) { const r = await query(`/content/${hash}`); if (r.text == null) throw new Error("not on agt-1"); return r.text; },
      async putContent(signer, text) { await signed(signer, { type: "content-put", text }); return ethers.keccak256(ethers.toUtf8Bytes(text)); },
      openContract: (s, licence, brief, milestones) => signed(s, { type: "eng-open", licence, brief, milestones: milestones.map(String) }),
      accept: (s, eng, m) => signed(s, { type: "eng-accept", eng, milestone: m }),
      revise: (s, eng, m, note) => signed(s, { type: "eng-revise", eng, milestone: m, note }),
      dispute: (s, eng, m) => signed(s, { type: "eng-dispute", eng, milestone: m }),
      cancel: (s, eng) => signed(s, { type: "eng-cancel", eng }),
      seal: (s, eng, box) => signed(s, { type: "seal-put", eng, box }),
      async transfer(signer, to, amount) {
        const me = await signer.getAddress();
        const st = await query("/state");
        const nonce = Number((await query(`/balance/${me}`)).nonce || 0);
        const tx = { type: "transfer", chainId: st.chainId, to, amount: BigInt(amount), fee: st.fee, nonce, from: me.toLowerCase() };
        const { sig, ...body } = tx;
        tx.sig = await signer.signMessage(ethers.getBytes(hashOf(body)));
        return send(tx);
      },
    };
  }
  root.AGT1 = { connect, canon, hashOf, HAT, DOOR };
})(typeof self !== "undefined" ? self : this);
