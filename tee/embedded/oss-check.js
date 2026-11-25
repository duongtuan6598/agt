// The checker of a self-found open-source contribution (THIET-KE-AI-TU-CHU.md, agreed with Codex and DeepSeek).
// Reviewers decide ONLY with this checker, on GitHub's structured data: they never read the words of an issue or a
// pull request to decide (those can carry instructions). Anyone can run it again on the same evidence:
//   node tee/embedded/oss-check.js <owner/repo> <pr> <agt1… of the AI>
// Evidence of the work, exactly: {"kind":"oss-pr","repo":"owner/repo","pr":123} (one spelling, so rules v10's
// "one evidence, paid once" also means "one pull request, paid once").
const { repoName } = require("./github.js");

const VERSION = "oss-check/1";
const DAY = 86400000;
const MAINTAINER_AGE_DAYS = 60;  // the person who merged contributed to the project at least this long before the PR
const OTHER_AUTHORS = 3;         // the project merged pull requests of at least this many other people before
const MIN_CODE_LINES = 5;        // changed lines of code or tests, not counting blank lines or comments
const DOC = /(^|\/)(docs?|documentation)\/|\.(md|rst|txt|adoc|html?)$|(^|\/)(README|CHANGELOG|LICENSE|AUTHORS|CONTRIBUTING)[^/]*$/i;
const COMMENT = /^\s*(\/\/|#|\/\*|\*|\*\/|--|;)/;

// the line the AI puts in every pull request it opens: it binds the GitHub account to the AI on agt-2
const marker = (agt1) => `AGT AI: ${agt1}`;

function evidenceOf(repo, pr) {
  return JSON.stringify({ kind: "oss-pr", repo: repoName(repo), pr: Number(pr) });
}
function parseEvidence(text) {
  const e = JSON.parse(text);
  if (!e || e.kind !== "oss-pr" || !Number.isInteger(e.pr) || e.pr <= 0) throw new Error("not oss-pr evidence");
  if (text !== evidenceOf(e.repo, e.pr)) throw new Error("evidence not in its one spelling");
  return e;
}

// code lines really changed in a patch: added or removed lines that are not blank and not only a comment
function codeLines(patch) {
  let n = 0;
  for (const l of String(patch || "").split("\n")) {
    if (!/^[+-]/.test(l) || /^(\+\+\+|---)/.test(l)) continue;
    const body = l.slice(1);
    if (!body.trim() || COMMENT.test(body)) continue;
    n++;
  }
  return n;
}

/// Run every check. Returns { version, ok, failed: [reasons], facts }. Never throws on a failed check.
async function check({ gh, repo, pr, agt1 }) {
  const facts = { repo: repoName(repo), pr: Number(pr) };
  const failed = [];
  const need = (cond, why) => { if (!cond) failed.push(why); return !!cond; };
  const r = await gh.get(`/repos/${facts.repo}`);
  if (!need(r, "the repository does not exist")) return { version: VERSION, ok: false, failed, facts };
  need(!r.fork, "the repository is a fork");
  need(!r.archived, "the repository is archived");
  need(r.license && r.license.spdx_id && r.license.spdx_id !== "NOASSERTION", "the repository has no open-source licence");
  const p = await gh.get(`/repos/${facts.repo}/pulls/${facts.pr}`);
  if (!need(p, "the pull request does not exist")) return { version: VERSION, ok: false, failed, facts };
  facts.author = p.user && p.user.login;
  facts.mergedBy = p.merged_by && p.merged_by.login;
  facts.mergeCommit = p.merge_commit_sha;
  need(p.merged === true && facts.mergeCommit, "the pull request is not merged");
  need(String(p.body || "").includes(marker(agt1)), "the pull request does not carry the line naming this AI");
  need(facts.mergedBy && facts.mergedBy.toLowerCase() !== String(facts.author).toLowerCase(), "merged by its own author");
  // the merge commit is on the default branch
  if (facts.mergeCommit) {
    const cmp = await gh.get(`/repos/${facts.repo}/compare/${encodeURIComponent(r.default_branch)}...${facts.mergeCommit}`);
    need(cmp && (cmp.status === "behind" || cmp.status === "identical"), "the merge commit is not on the default branch");
  }
  // the person who merged worked on the project long before this pull request
  if (facts.mergedBy) {
    const until = new Date(Date.parse(p.created_at) - MAINTAINER_AGE_DAYS * DAY).toISOString();
    const old = await gh.get(`/repos/${facts.repo}/commits?author=${encodeURIComponent(facts.mergedBy)}&until=${until}&per_page=1`);
    need(Array.isArray(old) && old.length > 0, `the person who merged has no commit in the project ${MAINTAINER_AGE_DAYS} days before the pull request`);
  }
  // the project takes work from other people: merged pull requests of several other authors before this one
  const before = p.created_at.slice(0, 10);
  const merged = await gh.get(`/search/issues?q=${encodeURIComponent(`repo:${facts.repo} is:pr is:merged created:<${before}`)}&per_page=100`);
  const authors = new Set(((merged && merged.items) || []).map((i) => i.user && i.user.login).filter((u) => u && u !== facts.author));
  facts.otherAuthors = authors.size;
  need(authors.size >= OTHER_AUTHORS, `fewer than ${OTHER_AUTHORS} other authors had pull requests merged there before`);
  // not trivial: the change touches code or tests, with enough real lines
  const files = await gh.all(`/repos/${facts.repo}/pulls/${facts.pr}/files`);
  const code = files.filter((f) => !DOC.test(f.filename));
  facts.codeLines = code.reduce((t, f) => t + codeLines(f.patch), 0);
  need(code.length > 0, "the change touches only documentation");
  need(facts.codeLines >= MIN_CODE_LINES, `fewer than ${MIN_CODE_LINES} real lines of code changed`);
  return { version: VERSION, ok: failed.length === 0, failed, facts };
}

module.exports = { VERSION, check, evidenceOf, parseEvidence, marker, codeLines };

if (require.main === module) {
  const [repo, pr, agt1] = process.argv.slice(2);
  check({ gh: require("./github.js").github({ token: process.env.GITHUB_TOKEN || null }), repo, pr: Number(pr), agt1 })
    .then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
}
