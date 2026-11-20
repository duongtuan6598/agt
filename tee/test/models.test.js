// Provider-independent model layer: only models fixed in the image can be used, the owner cannot point the
// AI at a server of their own, and the model identity is part of the attested manifest.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { ethers } = require("ethers");
const M = require("../box/models.js");
const T = require("../verify.js");

test("only approved providers can be used; unknown or unapproved ones are refused", () => {
  assert.deepEqual(M.modelIdentity("anthropic"), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.throws(() => M.modelIdentity("openai"), /not approved yet/);
  assert.throws(() => M.modelIdentity("local"), /not approved yet/);
  assert.throws(() => M.modelIdentity("my-own-server"), /unknown model provider/);
});

test("OpenAI-compatible providers call the FIXED url with the registry's model and a strict JSON schema", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"reject","flaw":"number","reason":"50 became 500 in the translation"}' } }] }) };
  };
  const chat = M.openaiCompatibleChat({ url: "https://api.openai.com/v1/chat/completions", model: "approved-model", apiKey: "k", fetchImpl: fakeFetch });
  const t = await chat({ system: "Charter rules", user: "item", json: M.REVIEW_SCHEMA });
  assert.equal(JSON.parse(t).verdict, "reject");
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].body.model, "approved-model");
  assert.equal(calls[0].body.messages[0].content, "Charter rules");
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
});

test("a model refusal never turns into an accept", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { refusal: "I can't help with that" } }] }) });
  const chat = M.openaiCompatibleChat({ url: "http://127.0.0.1:8081/v1/chat/completions", model: "m", fetchImpl: fakeFetch });
  assert.equal(await chat({ system: "s", user: "u" }), null);
  // through the shared layer (anthropic shape, fake client):
  const client = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } };
  const model = M.makeModel({ provider: "anthropic", client, systemPrompt: "s" });
  assert.equal((await model.review({ source: "a", glossary: [] }, "b")).verdict, "reject");
  assert.equal(JSON.parse(await model.answer({ id: "r1", source: "a", glossary: [], translation: "b" }, { task: "Review" })).verdict, "reject");
});

test("local weights are refused unless their sha256 matches the hash pinned in the image", async () => {
  const saved = JSON.parse(JSON.stringify(M.REGISTRY.local));
  try {
    const good = Buffer.from("pretend gguf weights");
    M.REGISTRY.local.weights = { url: "https://example.org/w.gguf", sha256: crypto.createHash("sha256").update(good).digest("hex") };
    const fakeFetch = (bytes) => async () => ({ ok: true, arrayBuffer: async () => bytes });
    const dest = require("path").join(require("os").tmpdir(), "agt-test-weights.gguf");
    assert.equal(await M.fetchLocalWeights(dest, fakeFetch(good)), dest);
    await assert.rejects(M.fetchLocalWeights(dest, fakeFetch(Buffer.from("swapped weights"))), /refusing to run an unapproved model/);
  } finally {
    M.REGISTRY.local = saved;
  }
});

test("a box whose manifest names an unapproved model is refused", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = [{ ...publicKey.export({ format: "jwk" }), kid: "k", alg: "RS256" }];
  const IMAGE = "sha256:" + "ab".repeat(32);
  const policy = { audience: T.AUDIENCE, hwmodels: ["GCP_AMD_SEV"], imageDigests: [IMAGE], charterHash: T.charterHash(), promptHashes: null, models: ["anthropic:claude-opus-5-5"] };
  const token = (m) => {
    const now = Math.floor(Date.now() / 1000);
    const c = { iss: T.ISSUER, aud: T.AUDIENCE, iat: now, nbf: now, exp: now + 3600, swname: "CONFIDENTIAL_SPACE", hwmodel: "GCP_AMD_SEV", dbgstat: "disabled-since-boot", secboot: true, submods: { confidential_space: { support_attributes: ["STABLE"] }, container: { image_digest: IMAGE, restart_policy: "Never" } }, eat_nonce: T.nonceOf(m) };
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = enc({ alg: "RS256", kid: "k" }) + "." + enc(c);
    return h + "." + crypto.sign("RSA-SHA256", Buffer.from(h), privateKey).toString("base64url");
  };
  const base = { agt: "sealed-box-v1", chainId: "agt-1", charterHash: T.charterHash(), promptHash: ethers.id("p"), agent: ethers.Wallet.createRandom().address, cmtPubKey: crypto.randomBytes(32).toString("base64") };
  const ok = { ...base, model: { provider: "anthropic", model: "claude-opus-5-5" } };
  T.verifyEvidence({ manifest: ok, token: token(ok) }, { jwks, policy });
  const bad = { ...base, model: { provider: "openai", model: "someone-elses-endpoint" } };
  assert.throws(() => T.verifyEvidence({ manifest: bad, token: token(bad) }, { jwks, policy }), /model openai:someone-elses-endpoint is not approved/);
});
