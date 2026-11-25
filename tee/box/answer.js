// The AI inside the sealed box answers its own exam with Claude (Charter Articles 5 and 12).
// The model id and the system prompt are fixed in the image (both covered by the attestation);
// the owner only supplies an API key — through Secret Manager, never through env (env values
// appear in the public attestation token).
const { REGISTRY, REVIEW_SCHEMA, makeModel } = require("./models.js");

const MODEL = REGISTRY.anthropic.model;

// Returns async (question, paper) => answer string, as exam-worker/client.js expects.
function makeAnswerer({ apiKey, systemPrompt, client, provider = "anthropic", fetchImpl }) {
  return makeModel({ provider, apiKey, client, systemPrompt, fetchImpl }).answer;
}

// Inside Confidential Space: read the API key with the VM's own service account.
async function secretFromManager(name, envOverride = "AGT_MODEL_KEY") {
  // On dstack the key arrives as an ENCRYPTED env var, decrypted only inside the TDX box (not in the quote).
  if (process.env[envOverride]) return process.env[envOverride];
  const tok = await (await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } })).json();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!r.ok) throw new Error(`Secret Manager ${r.status}`);
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

module.exports = { MODEL, REVIEW_SCHEMA, makeAnswerer, secretFromManager };
