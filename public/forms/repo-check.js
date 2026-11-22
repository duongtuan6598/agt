// Checks a client's GitHub repository BEFORE money moves or a token is sealed (rehearsal finding T-7: an engagement
// was opened and funded on the wrong, empty, public repository). Runs in the browser (engage.html) and in Node
// (tools/rehearse-client.js). The token is only sent to api.github.com and is never stored or logged.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AGTRepoCheck = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const API = "https://api.github.com/repos/";

  function parse(url) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url || "").trim());
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  const get = async (path, token) => {
    const headers = { accept: "application/vnd.github+json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(API + path, { headers });
    return { status: r.status, body: r.ok ? await r.json() : null };
  };

  // Before opening and funding: what can be seen without a token. Problems are returned, never thrown.
  async function beforeFunding(url, { needPrivate = false } = {}) {
    const p = parse(url);
    if (!p) return ["The repository must be a GitHub URL like https://github.com/owner/name."];
    const r = await get(`${p.owner}/${p.repo}`);
    if (r.status === 404) return []; // private (or missing): checked with the token before sealing
    if (r.status !== 200) return [`GitHub did not answer (${r.status}); try again.`];
    const out = [];
    if (needPrivate) out.push("This repository is PUBLIC, but the AI's memory hand-over needs a private repository.");
    const b = await get(`${p.owner}/${p.repo}/branches?per_page=1`);
    if (b.status === 200 && b.body.length === 0) out.push("This repository is EMPTY. Push your code and CI first, or check the URL.");
    return out;
  }

  // Before sealing a token: the token must see the repository, and the repository must hold code.
  async function beforeSealing(url, token, { needPrivate = false } = {}) {
    const p = parse(url);
    if (!p) return ["The repository must be a GitHub URL like https://github.com/owner/name."];
    if (!token) return ["No token given."];
    const r = await get(`${p.owner}/${p.repo}`, token);
    if (r.status === 401) return ["GitHub refused this token (expired or mistyped)."];
    if (r.status === 404 || r.status === 403) return ["This token cannot see the repository. Check the URL and the token's repository access."];
    if (r.status !== 200) return [`GitHub did not answer (${r.status}); try again.`];
    const out = [];
    if (needPrivate && !r.body.private) out.push("This repository is PUBLIC, but the AI's memory hand-over needs a private repository.");
    const b = await get(`${p.owner}/${p.repo}/branches?per_page=1`, token);
    if (b.status !== 200) out.push("This token cannot read the repository's contents (it needs Contents: read and write).");
    else if (!b.body.length) out.push("The repository is EMPTY. Push your code and CI first.");
    return out;
  }

  return { parse, beforeFunding, beforeSealing };
});
