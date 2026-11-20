// Reading the client's CI results (THIET-KE-NGHE-NHUNG.md §12, joint decision of Claude and Codex): the client's
// own CI runs N1–N4 on the branch the AI pushed; the sealed box only READS the results. No client code runs in
// the box. The repository token goes only to the forge's own API host, matching the repository host.
//   GitHub: check runs + commit statuses of the commit;  GitLab: commit statuses (pipeline jobs).
// Everything returned (names, summaries, annotations) is UNTRUSTED text from the client's CI.
// Reviewed with Codex (F-1, F-6, F-7): re-runs → newest wins; the same name from two sources → ambiguous → fails;
// every page is read (bounded); repository URLs are canonical and allow-listed.

const APIS = {
  "github.com": { api: "https://api.github.com", kind: "github" },
  "gitlab.com": { api: "https://gitlab.com/api/v4", kind: "gitlab" },
};
const MAX_PAGES = 5;
const PENDING_GITLAB = ["pending", "running", "created", "waiting_for_resource", "preparing", "scheduled", "manual"];

function repoOf(url) {
  const canonical = require("./workspace.js").checkRepoUrl(url, false);
  const u = new URL(canonical);
  const host = u.hostname.toLowerCase();
  const api = APIS[host];
  if (!api) throw new Error(`no CI reader for ${host} (supported: ${Object.keys(APIS).join(", ")})`);
  const p = u.pathname.replace(/\.git$/, "").replace(/^\//, "");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error("bad repository path");
  return { ...api, host, path: p };
}

const SUCCESS = new Set(["success"]);
const NEUTRAL = new Set(["neutral", "skipped"]);

/// Normalised CI state of one commit for the REQUIRED check names (from the brief).
///   { state: "pending" | "success" | "failure", checks: [{name, conclusion, url}], failures: "text for the model" }
async function ciStatus({ repository, token, sha, required, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("bad commit sha");
  if (!Array.isArray(required) || !required.length) throw new Error("the brief names no required CI checks");
  const r = repoOf(repository);
  const get = async (u, headers) => {
    const res = await fetchImpl(u, { headers, redirect: "error" });
    if (!res.ok) throw new Error(`CI API ${res.status}`);
    return res.json();
  };
  // every page, bounded: an incomplete read fails closed
  const all = async (base, headers, pick) => {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = pick(await get(`${base}${base.includes("?") ? "&" : "?"}per_page=100&page=${page}`, headers));
      if (!Array.isArray(items)) throw new Error("malformed CI response");
      out.push(...items);
      if (items.length < 100) return out;
    }
    throw new Error("too many CI results to read completely");
  };

  const found = new Map(); // name → { conclusion, url, detail, id, source }
  const ambiguous = new Set();
  const add = (name, v) => {
    const prev = found.get(name);
    if (!prev) found.set(name, v);
    else if (prev.source !== v.source) ambiguous.add(name); // two sources claim the same check name
    else if (v.id > prev.id) found.set(name, v); // a re-run: the newest counts
  };

  if (r.kind === "github") {
    const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agt-sealed-ai" };
    for (const c of await all(`${r.api}/repos/${r.path}/commits/${sha}/check-runs`, h, (b) => b && b.check_runs)) {
      const conclusion = c.status !== "completed" ? "pending" : c.conclusion || "pending";
      const detail = [c.output && c.output.title, c.output && c.output.summary, c.output && c.output.text].filter(Boolean).join("\n").slice(0, 4000);
      add(c.name, { conclusion, url: c.html_url || null, id: Number(c.id) || 0, source: "check:" + ((c.app && c.app.slug) || "?"), detail });
    }
    const st = await get(`${r.api}/repos/${r.path}/commits/${sha}/status`, h);
    for (const s of (st && st.statuses) || []) add(s.context, { conclusion: s.state === "pending" ? "pending" : s.state, url: s.target_url || null, id: Number(s.id) || 0, source: "status", detail: String(s.description || "").slice(0, 1000) });
  } else {
    const h = { "PRIVATE-TOKEN": token, "User-Agent": "agt-sealed-ai" };
    for (const s of await all(`${r.api}/projects/${encodeURIComponent(r.path)}/repository/commits/${sha}/statuses`, h, (b) => b)) {
      const conclusion = PENDING_GITLAB.includes(s.status) ? "pending" : s.status === "success" ? "success" : s.status === "skipped" ? "skipped" : "failure";
      add(s.name, { conclusion, url: s.target_url || null, id: Number(s.id) || 0, source: "gitlab", detail: String(s.description || "").slice(0, 1000) });
    }
  }
  for (const name of ambiguous) found.set(name, { conclusion: "ambiguous", url: null, detail: `"${name}" is reported by more than one source — rename one check or pin its source` });

  const checks = required.map((name) => ({ name, ...(found.get(name) || { conclusion: "pending", url: null, detail: "" }) }));
  const failed = checks.filter((c) => !SUCCESS.has(c.conclusion) && !NEUTRAL.has(c.conclusion) && c.conclusion !== "pending");
  const pending = checks.filter((c) => c.conclusion === "pending");
  const state = failed.length ? "failure" : pending.length ? "pending" : checks.every((c) => SUCCESS.has(c.conclusion)) ? "success" : "failure";
  const failures = failed.map((c) => `CI check "${c.name}": ${c.conclusion}\n${c.detail}`).join("\n\n").slice(0, 12000);
  return { state, checks: checks.map(({ name, conclusion, url }) => ({ name, conclusion, url })), failures };
}

module.exports = { ciStatus, repoOf, APIS };
