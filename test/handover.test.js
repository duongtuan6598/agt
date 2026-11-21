// Codex N-1: the plaintext memory hand-over happens only when the brief asks for it, only into a PRIVATE repository,
// and credentials are redacted first.
const test = require("node:test");
const assert = require("node:assert");
const { EngageLoop, redact } = require("../tee/embedded/engage-agent.js");

function fakeLoop({ handover, visibility, secret = "ghp_" + "z".repeat(36) }) {
  const pushed = [];
  const state = new Map();
  const loop = Object.create(EngageLoop.prototype);
  Object.assign(loop, {
    memStoreFor: () => ({ exportPlain: (branch, file, text) => pushed.push({ branch, file, text }) }),
    visibility: async () => visibility,
    state: { get: async (k) => state.get(k) ?? null, set: async (k, v) => void state.set(k, v) },
    log: () => {}, now: () => 1,
    engagementsOf: async () => [{ id: 5, e: { ended: true, startedAt: 1, brief: "0x1" } }],
    brief: async () => ({ b: { fields: { repository: "https://github.com/o/r", ...(handover ? { memoryHandover: handover } : {}) } } }),
    token: async () => "t",
    openMemory: async () => ({ export: async () => ({ context: "c", entries: [{ text: `deploy key token: ${secret}` }] }) }),
  });
  return { loop, pushed, state };
}

test("not asked for in the brief → nothing leaves, ever", async () => {
  const { loop, pushed } = fakeLoop({ handover: undefined, visibility: "private" });
  await loop.exportEnded(1);
  assert.equal(pushed.length, 0);
});

test("asked for, but the repository is public → waits, nothing pushed", async () => {
  const { loop, pushed, state } = fakeLoop({ handover: "private-repo", visibility: "public" });
  await loop.exportEnded(1);
  assert.equal(pushed.length, 0);
  assert.equal(state.has("export:engagement:5"), false, "it will try again (the client may make the repo private)");
});

test("asked for, private repository → handed over once, with credentials redacted", async () => {
  const { loop, pushed } = fakeLoop({ handover: "private-repo", visibility: "private" });
  await loop.exportEnded(1);
  await loop.exportEnded(1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].branch, "agt/memory-export-5");
  assert.ok(!pushed[0].text.includes("ghp_zzzz"), "the token is redacted");
  assert.match(pushed[0].text, /\[redacted/);
});

test("redaction keeps ordinary text and hashes", () => {
  const s = "commit 0x" + "b".repeat(64) + "; the token was rotated";
  assert.equal(redact(s), s);
});
