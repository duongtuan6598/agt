// Repository checks before funding and before sealing a token (rehearsal finding T-7), against a fake GitHub.
const test = require("node:test");
const assert = require("node:assert");
const RC = require("../public/forms/repo-check.js");

function fakeGitHub(repos) {
  global.fetch = async (url, { headers } = {}) => {
    const path = url.replace("https://api.github.com/repos/", "");
    const [owner, name] = path.split("?")[0].split("/");
    const r = repos[`${owner}/${name}`];
    const auth = headers && headers.authorization;
    const reply = (status, body) => ({ status, ok: status === 200, json: async () => body });
    if (auth === "Bearer bad") return reply(401);
    if (!r || (r.private && auth !== "Bearer good")) return reply(404);
    return path.includes("/branches") ? reply(200, r.branches) : reply(200, { private: r.private });
  };
}

test("an empty public repository is refused before funding and before sealing", async () => {
  fakeGitHub({ "a/empty": { private: false, branches: [] } });
  const f = await RC.beforeFunding("https://github.com/a/empty", { needPrivate: true });
  assert.equal(f.length, 2);
  assert.match(f.join(" "), /PUBLIC/);
  assert.match(f.join(" "), /EMPTY/);
  assert.equal((await RC.beforeSealing("https://github.com/a/empty", "good", { needPrivate: true })).length, 2);
});

test("a private repository with code passes; a public one passes only when no private hand-over is asked", async () => {
  fakeGitHub({ "a/fw": { private: true, branches: [{ name: "main" }] }, "a/pub": { private: false, branches: [{ name: "main" }] } });
  assert.deepEqual(await RC.beforeFunding("https://github.com/a/fw", { needPrivate: true }), []);
  assert.deepEqual(await RC.beforeSealing("https://github.com/a/fw.git", "good", { needPrivate: true }), []);
  assert.deepEqual(await RC.beforeFunding("https://github.com/a/pub"), []);
  assert.equal((await RC.beforeFunding("https://github.com/a/pub", { needPrivate: true })).length, 1);
});

test("a token that cannot see the repository, a refused token and a non-GitHub URL are reported", async () => {
  fakeGitHub({ "a/fw": { private: true, branches: [{ name: "main" }] } });
  assert.match((await RC.beforeSealing("https://github.com/a/fw", "other")).join(), /cannot see/);
  assert.match((await RC.beforeSealing("https://github.com/a/fw", "bad")).join(), /refused this token/);
  assert.match((await RC.beforeFunding("https://gitlab.com/a/fw")).join(), /GitHub URL/);
});
