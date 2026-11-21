// Testnet rehearsal finding: fine-grained GitHub tokens cannot get the Checks permission, so check-runs answer 403.
// The CI reader then reads the same results as Actions jobs (Actions: read), with the same rules.
const test = require("node:test");
const assert = require("node:assert");
const { ciStatus } = require("../tee/embedded/forge.js");

const SHA = "a".repeat(40);
function fakeGitHub({ jobs, checksStatus = 403 }) {
  return async (url) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes("/check-runs")) return { ok: false, status: checksStatus, json: async () => ({}) };
    if (u.includes("/status")) return ok({ statuses: [] });
    if (/\/actions\/runs\?head_sha=/.test(u)) return ok(/[?&]page=1$/.test(u) ? { workflow_runs: [{ id: 7, head_sha: SHA }, { id: 8, head_sha: "b".repeat(40) }] } : { workflow_runs: [] });
    if (/\/actions\/runs\/7\/jobs/.test(u)) return ok(/[?&]page=1$/.test(u) ? { jobs } : { jobs: [] });
    throw new Error("unexpected " + u);
  };
}
const q = (fetchImpl) => ciStatus({ repository: "https://github.com/o/r", token: "t", sha: SHA, required: ["build", "unit-tests"], fetchImpl });

test("403 on check-runs → the jobs of this commit's Actions runs decide", async () => {
  const r = await q(fakeGitHub({ jobs: [{ id: 1, name: "build", status: "completed", conclusion: "success", head_sha: SHA }, { id: 2, name: "unit-tests", status: "completed", conclusion: "success", head_sha: SHA }] }));
  assert.equal(r.state, "success");
});

test("a failing job fails the commit and says which step; a newer re-run counts", async () => {
  const r = await q(fakeGitHub({ jobs: [
    { id: 1, name: "build", status: "completed", conclusion: "success", head_sha: SHA },
    { id: 2, name: "unit-tests", status: "completed", conclusion: "success", head_sha: SHA },
    { id: 3, name: "unit-tests", status: "completed", conclusion: "failure", head_sha: SHA, steps: [{ name: "make -C fw test", conclusion: "failure" }] },
  ] }));
  assert.equal(r.state, "failure");
  assert.match(r.failures, /make -C fw test/);
});

test("a job still running keeps the commit pending; other errors are not swallowed", async () => {
  const r = await q(fakeGitHub({ jobs: [{ id: 1, name: "build", status: "in_progress", conclusion: null, head_sha: SHA }, { id: 2, name: "unit-tests", status: "completed", conclusion: "success", head_sha: SHA }] }));
  assert.equal(r.state, "pending");
  await assert.rejects(q(fakeGitHub({ jobs: [], checksStatus: 500 })), /CI API 500/);
});
