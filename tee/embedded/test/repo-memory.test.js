// §16: the AI's memory as ciphertext in the client's own repository (branch agt/memory), with real git.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { EngagementMemory } = require("../memory.js");
const { RepoMemoryStore, MemoryConflict } = require("../repo-memory.js");
const E = require("../../escrow.js");

const GIT = process.env.AGT_TEST_GIT || (process.platform === "win32" ? execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() : "git");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agt-rm-"));
function clientRepo() {
  const bare = path.join(tmp(), "client.git");
  execFileSync(GIT, ["init", "-q", "--bare", bare]);
  return { bare, url: "file:///" + bare.split(path.sep).join("/") };
}
const CTX = "engagement:97:0xabc:7";
const master = E.derive(E.newMaster()).memory;
const box = (url) => new RepoMemoryStore({ dir: path.join(tmp(), "mem.git"), url, token: "t", git: GIT, allowFileUrls: true });
const remoteGit = (bare, args) => execFileSync(GIT, ["--git-dir", bare, ...args], { encoding: "utf8" });

test("a replaced VM (same escrowed key, empty disk) gets the whole memory back from the client's repository", async () => {
  const { url, bare } = clientRepo();
  const m1 = new EngagementMemory(master, CTX, box(url));
  await m1.append("decision", "use the HAL timer, not SysTick");
  await m1.append("bug", "UART overrun at 921600 baud");
  const m2 = new EngagementMemory(master, CTX, box(url), { anchor: await m1.head() });
  assert.deepStrictEqual((await m2.entries()).map((e) => e.text), ["use the HAL timer, not SysTick", "UART overrun at 921600 baud"]);
  const blobs = remoteGit(bare, ["ls-tree", "-r", "agt/memory"]).trim().split("\n").map((l) => l.split(/\s+/)[2]);
  for (const b of blobs) assert.ok(!remoteGit(bare, ["cat-file", "blob", b]).includes("SysTick"), "the client's repository holds only ciphertext");
  assert.ok(remoteGit(bare, ["ls-tree", "--name-only", "agt/memory"]).split("\n").every((f) => !f.includes(":")), "portable file names");
});

test("two boxes appending at once: one wins, the other gets a conflict, nothing is overwritten", async () => {
  const { url } = clientRepo();
  const a = new EngagementMemory(master, CTX, box(url));
  await a.append("note", "first");
  const sa = box(url), sb = box(url);
  const ma = new EngagementMemory(master, CTX, sa), mb = new EngagementMemory(master, CTX, sb);
  // both read head 1, then both try to write entry 1
  const ea = { n: 1, kind: "note", text: "from A", at: 1, prev: await ma.head() };
  const eb = { n: 1, kind: "note", text: "from B", at: 1, prev: await mb.head() };
  await sa.put(ma.nameAt(1), ma._enc(ea));
  await assert.rejects(sb.put(mb.nameAt(1), mb._enc(eb)), MemoryConflict);
  assert.deepStrictEqual((await new EngagementMemory(master, CTX, box(url)).entries()).map((e) => e.text), ["first", "from A"]);
});

test("rollback or deletion of the branch fails closed against the on-chain anchor", async () => {
  const { url, bare } = clientRepo();
  const m = new EngagementMemory(master, CTX, box(url));
  await m.append("note", "one");
  const old = remoteGit(bare, ["rev-parse", "agt/memory"]).trim();
  await m.append("note", "two");
  const anchor = await m.head(); // recorded in a delivery report on chain
  remoteGit(bare, ["update-ref", "refs/heads/agt/memory", old]); // the client (or anyone with access) rolls back
  await assert.rejects(new EngagementMemory(master, CTX, box(url), { anchor }).entries(), /rolled back/);
  remoteGit(bare, ["update-ref", "-d", "refs/heads/agt/memory"]); // … or deletes it
  await assert.rejects(new EngagementMemory(master, CTX, box(url), { anchor }).entries(), /rolled back/);
  assert.deepStrictEqual(await new EngagementMemory(master, CTX, box(url)).entries(), [], "without the anchor it would look like a new client — which is why every read carries it");
});

test("another engagement's key cannot read or extend this memory", async () => {
  const { url } = clientRepo();
  await new EngagementMemory(master, CTX, box(url)).append("note", "secret design");
  const other = new EngagementMemory(master, "engagement:97:0xabc:8", box(url));
  assert.deepStrictEqual(await other.entries(), [], "different HMAC names: not even listed");
});

test("anything an AGT box would not write on the branch (big blob, symlink, stray file) fails closed (Codex M-2)", async () => {
  const cases = [
    ["a huge blob", (w) => fs.writeFileSync(path.join(w, "mem_" + "a".repeat(32) + "_00000000"), "x".repeat(200 * 1024))],
    ["a stray file", (w) => fs.writeFileSync(path.join(w, "README.md"), "hello")],
    ["a symlink", (w) => { execFileSync(GIT, ["-C", w, "update-index", "--add", "--cacheinfo", `120000,${execFileSync(GIT, ["-C", w, "hash-object", "-w", "--stdin"], { input: "/etc/passwd", encoding: "utf8" }).trim()},mem_${"c".repeat(32)}_00000000`]); }],
  ];
  for (const [what, plant] of cases) {
    const { url, bare } = clientRepo();
    const w = tmp();
    execFileSync(GIT, ["init", "-q", w]);
    plant(w);
    if (what !== "a symlink") execFileSync(GIT, ["-C", w, "add", "-A"]); // the symlink is staged directly (no worktree file)
    execFileSync(GIT, ["-C", w, "-c", "user.name=c", "-c", "user.email=c@c", "commit", "-q", "-m", "x"]);
    execFileSync(GIT, ["-C", w, "push", "-q", bare, "HEAD:refs/heads/agt/memory"]);
    await assert.rejects(new EngagementMemory(master, CTX, box(url)).entries(), /unexpected content|entries/, what);
    await assert.rejects(new EngagementMemory(master, CTX, box(url)).append("note", "x"), /unexpected content|entries/, `${what}: no write on top of it either`);
  }
});
