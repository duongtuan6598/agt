// Content is addressed by its hash: the store cannot swap the text behind an on-chain hash.
const test = require("node:test");
const assert = require("node:assert");
test("the content store cannot substitute text for an on-chain hash (Codex M-3)", async () => {
  const { ethers } = require("ethers");
  const { httpContent } = require("../tee/box/agent.js");
  const real = "{\"memoryHead\":\"" + "a".repeat(64) + "\"}";
  const hash = ethers.keccak256(ethers.toUtf8Bytes(real));
  const saved = global.fetch;
  try {
    global.fetch = async () => ({ json: async () => ({ ok: true, text: real }) });
    assert.equal(await httpContent("http://x", null).get(hash), real);
    global.fetch = async () => ({ json: async () => ({ ok: true, text: "{\"memoryHead\":\"genesis\"}" }) });
    await assert.rejects(httpContent("http://x", null).get(hash), /does not match its hash/);
  } finally { global.fetch = saved; }
});
