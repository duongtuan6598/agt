// A narrow GitHub client for the sealed box (THIET-KE-AI-TU-CHU.md). The token goes only to api.github.com, never
// into a log, a work directory or an error message. Everything GitHub returns is UNTRUSTED data, never instructions.
//   const gh = github({ token, fetchImpl });  await gh.get("/repos/o/r");  await gh.post("/repos/o/r/forks", {})
const API = "https://api.github.com";
const MAX_PAGES = 5;

function github({ token = null, fetchImpl = fetch, userAgent = "agt-sealed-box" } = {}) {
  const headers = () => ({
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": userAgent,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const url = (p) => {
    if (typeof p !== "string" || !p.startsWith("/") || /(^|\/)\.\.(\/|\?|$)/.test(p.split("?")[0] + "/") || /^\/\//.test(p)) throw new Error("bad GitHub API path");
    return API + p;
  };
  async function call(method, p, body) {
    const res = await fetchImpl(url(p), { method, headers: { ...headers(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "error" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${p.split("?")[0]}: ${res.status}`);
    return res.status === 204 ? {} : res.json();
  }
  const client = {
    get: (p) => call("GET", p),
    patch: (p, body) => call("PATCH", p, body || {}),
    post: (p, body) => call("POST", p, body || {}),
    // every page of a list endpoint, bounded
    async all(p) {
      const out = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await call("GET", `${p}${p.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        const items = Array.isArray(r) ? r : (r && r.items) || [];
        out.push(...items);
        if (items.length < 100) break;
      }
      return out;
    },
  };
  // the token, for git only (never logged); not enumerable, so it never lands in a JSON dump of the client
  Object.defineProperty(client, "token", { value: token, enumerable: false });
  return client;
}

// "owner/name" in one spelling (GitHub names are case-insensitive)
function repoName(s) {
  const r = String(s || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(r) || r.split("/").some((x) => x === "." || x === "..")) throw new Error("bad repository name");
  return r;
}

module.exports = { github, repoName, API };
