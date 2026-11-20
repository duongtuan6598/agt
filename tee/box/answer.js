// The AI inside the sealed box answers its own exam with Claude (Charter Articles 5 and 12).
// The model id and the system prompt are fixed in the image (both covered by the attestation);
// the owner only supplies an API key — through Secret Manager, never through env (env values
// appear in the public attestation token).
const AnthropicMod = require("@anthropic-ai/sdk");
const Anthropic = AnthropicMod.default || AnthropicMod;

const MODEL = "claude-opus-5-5";

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

function textOf(response) {
  if (response.stop_reason === "refusal") return null;
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// Returns async (question, paper) => answer string, as exam-worker/client.js expects.
function makeAnswerer({ apiKey, systemPrompt, client = new Anthropic({ apiKey }) }) {
  return async (q, paper) => {
    const review = "translation" in q;
    const request = {
      model: MODEL,
      max_tokens: 16000,
      system: systemPrompt,
      output_config: review ? { effort: "high", format: { type: "json_schema", schema: REVIEW_SCHEMA } } : { effort: "high" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{
        role: "user",
        content:
          `${paper.task}\n\nItem (JSON):\n${JSON.stringify(q, null, 2)}\n\n` +
          (review
            ? "Answer with the JSON object only."
            : "Answer with the Vietnamese translation only — no notes, no quotes, same paragraphs."),
      }],
    };
    const text = textOf(await client.beta.messages.create(request));
    if (text === null) return review ? JSON.stringify({ verdict: "reject", flaw: "meaning", reason: "model declined to review this item" }) : "";
    return text;
  };
}

// Inside Confidential Space: read the API key with the VM's own service account.
async function secretFromManager(name) {
  // On dstack the key arrives as an ENCRYPTED env var, decrypted only inside the TDX box (not in the quote).
  if (process.env.AGT_MODEL_KEY) return process.env.AGT_MODEL_KEY;
  const tok = await (await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } })).json();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!r.ok) throw new Error(`Secret Manager ${r.status}`);
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

module.exports = { MODEL, REVIEW_SCHEMA, makeAnswerer, secretFromManager };
