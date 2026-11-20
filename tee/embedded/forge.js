// Reading the client's CI results (THIET-KE-NGHE-NHUNG.md §12, joint decision of Claude and Codex): the client's
// own CI runs N1–N4 on the branch the AI pushed; the sealed box only READS the results. No client code runs in
// the box. The repository token goes only to the forge's own API host, matching the repository host.
//   GitHub: check runs + commit statuses of the commit;  GitLab: commit statuses (pipeline jobs).
// Everything returned (names, summaries, annotations) is UNTRUSTED text from the client's CI.

const APIS = {
  "github.com": { api: "https://api.github.com", kind: "github" },
  "gitlab.com": { api: "https://gitlab.com/api/v4", kind: "gitlab" },
};

function repoOf(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const api = APIS[host];
  if (!api) throw new Error(`no CI reader for ${host} (supported: ${Object.keys(APIS).join(", ")})`);
  const p = u.pathname.replace(/\.git$/, "").replace(/^\//, "");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(p)) throw new Error("bad repository path");
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
  const found = new Map(); // name → { conclusion, url, detail }
  if (r.kind === "github") {
    const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agt-sealed-ai" };
    const runs = await get(`${r.api}/repos/${r.path}/commits/${sha}/check-runs?per_page=100`, h);
    for (const c of runs.check_runs || []) {
      const conclusion = c.status !== "completed" ? "pending" : c.conclusion || "pending";
      found.set(c.name, { conclusion, url: c.html_url || null, detail: [c.output && c.output.title, c.output && c.output.summary, c.output && c.output.text].filter(Boolean).join("\n").slice(0, 4000) });
    }
    const st = await get(`${r.api}/repos/${r.path}/commits/${sha}/status`, h);
    for (const s of st.statuses || []) if (!found.has(s.context)) found.set(s.context, { conclusion: s.state === "pending" ? "pending" : s.state, url: s.target_url || null, detail: String(s.description || "").slice(0, 1000) });
  } else {
    const h = { "PRIVATE-TOKEN": token, "User-Agent": "agt-sealed-ai" };
    const list = await get(`${r.api}/projects/${encodeURIComponent(r.path)}/repository/commits/${sha}/statuses?per_page=100`, h);
    for (const s of list || []) {
      const conclusion = ["pending", "running", "created", "waiting_for_resource", "preparing", "scheduled", "manual"].includes(s.status) ? "pending" : s.status === "success" ? "success" : s.status === "skipped" ? "skipped" : "failure";
      found.set(s.name, { conclusion, url: s.target_url || null, detail: String(s.description || "").slice(0, 1000) });
    }
  }
  const checks = required.map((name) => ({ name, ...(found.get(name) || { conclusion: "pending", url: null, detail: "" }) }));
  const failed = checks.filter((c) => !SUCCESS.has(c.conclusion) && !NEUTRAL.has(c.conclusion) && c.conclusion !== "pending");
  const pending = checks.filter((c) => c.conclusion === "pending");
  const state = failed.length ? "failure" : pending.length ? "pending" : checks.every((c) => SUCCESS.has(c.conclusion)) ? "success" : "failure";
  const failures = failed.map((c) => `CI check "${c.name}": ${c.conclusion}\n${c.detail}`).join("\n\n").slice(0, 12000);
  return { state, checks: checks.map(({ name, conclusion, url }) => ({ name, conclusion, url })), failures };
}

module.exports = { ciStatus, repoOf, APIS };
