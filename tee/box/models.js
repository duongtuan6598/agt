// One model layer for the sealed AI: exam answers, translations and reviews, whatever the provider.
//   anthropic — Claude via the official SDK (api.anthropic.com)
//   openai    — OpenAI chat completions at a FIXED url
//   local     — an open-weights model served inside the box (llama.cpp, OpenAI-compatible, 127.0.0.1)
// The registry (models.json) is baked into the image; the owner chooses only among its entries.
const crypto = require("crypto");
const fs = require("fs");
const REGISTRY = require("./models.json");

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["accept", "reject"] },
    flaw: { type: "string", enum: ["meaning", "omission", "number", "terminology", "addition", "untranslated"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

// The model identity recorded in the manifest (and therefore in the attestation).
function modelIdentity(provider = "anthropic") {
  const e = REGISTRY[provider];
  if (!e || provider.startsWith("_")) throw new Error(`unknown model provider ${provider}`);
  if (!e.model) throw new Error(`model provider ${provider} is not approved yet (models.json)`);
  const id = { provider, model: e.model };
  if (provider === "local") id.weightsSha256 = e.weights.sha256;
  return id;
}

// chat({ system, user, json }) → text, or null if the model declined.
function anthropicChat({ client, model }) {
  return async ({ system, user, json }) => {
    const r = await client.beta.messages.create({
      model, max_tokens: 16000, system,
      output_config: json ? { effort: "high", format: { type: "json_schema", schema: json } } : { effort: "high" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      messages: [{ role: "user", content: user }],
    });
    if (r.stop_reason === "refusal") return null;
    return r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  };
}
function openaiCompatibleChat({ url, model, apiKey, fetchImpl = fetch }) {
  return async ({ system, user, json }) => {
    const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    if (json) body.response_format = { type: "json_schema", json_schema: { name: "review", schema: json, strict: true } };
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const msg = (await r.json()).choices?.[0]?.message;
    if (!msg || msg.refusal) return null;
    return String(msg.content || "").trim();
  };
}

function chatFor({ provider = "anthropic", apiKey, client, fetchImpl }) {
  const id = modelIdentity(provider);
  const e = REGISTRY[provider];
  if (provider === "anthropic") {
    if (!client) {
      const A = require("@anthropic-ai/sdk");
      client = new (A.default || A)({ apiKey });
    }
    return anthropicChat({ client, model: id.model });
  }
  return openaiCompatibleChat({ url: e.url, model: id.model, apiKey: provider === "openai" ? apiKey : null, fetchImpl });
}

// Everything the AI does with a model, independent of the provider.
function makeModel({ systemPrompt, ...opts }) {
  const chat = chatFor(opts);
  const reject = (reason) => ({ verdict: "reject", flaw: "meaning", reason });
  const parse = (t, why) => { try { return t ? JSON.parse(t) : reject(why); } catch { return reject("model gave no valid verdict"); } };
  return {
    // Exam: a translation item → text; a review item → JSON string (as the exam expects).
    async answer(q, paper) {
      const review = "translation" in q;
      const t = await chat({
        system: systemPrompt, json: review ? REVIEW_SCHEMA : null,
        user: `${paper.task}\n\nItem (JSON):\n${JSON.stringify(q, null, 2)}\n\n${review ? "Answer with the JSON object only." : "Answer with the Vietnamese translation only — no notes, no quotes, same paragraphs."}`,
      });
      if (!review) return t || "";
      return JSON.stringify(parse(t, "model declined to review this item"));
    },
    async translate(task) {
      return chat({
        system: systemPrompt,
        user: `Translate this open document from English into Vietnamese. Keep links, code spans and every number exactly as written, use the glossary term for each listed source term, keep the same paragraphs. Answer with the translation only.\n\nTask (JSON):\n${JSON.stringify({ title: task.title, glossary: task.glossary, source: task.source }, null, 2)}`,
      });
    },
    async review(task, translation) {
      const t = await chat({
        system: systemPrompt, json: REVIEW_SCHEMA,
        user: `You were drawn at random to review another AI's work for AGT. Decide whether the Vietnamese translation faithfully renders the English source: complete meaning, every number, the required glossary terms, nothing added, fully translated. Accepting a flawed translation mints AGT for bad work — when in doubt, reject. Answer with the JSON object only.\n\nItem (JSON):\n${JSON.stringify({ source: task.source, glossary: task.glossary, translation }, null, 2)}`,
      });
      return parse(t, "model declined to review this item");
    },
  };
}

// Local model: download the weights and refuse them unless the pinned sha256 matches.
async function fetchLocalWeights(dest, fetchImpl = fetch) {
  const w = REGISTRY.local.weights;
  if (!w.url || !w.sha256) throw new Error("no local model approved yet (models.json)");
  const r = await fetchImpl(w.url);
  if (!r.ok) throw new Error(`weights: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  if (got !== w.sha256) throw new Error(`weights hash ${got} ≠ pinned ${w.sha256} — refusing to run an unapproved model`);
  fs.writeFileSync(dest, buf);
  return dest;
}

module.exports = { REGISTRY, REVIEW_SCHEMA, modelIdentity, makeModel, chatFor, openaiCompatibleChat, anthropicChat, fetchLocalWeights };
