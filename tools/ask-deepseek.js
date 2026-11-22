// Ask DeepSeek for an independent opinion (one of the AIs that decide AGT together, with Claude and Codex).
// Calls DeepSeek's official API directly; no third-party package. Only public code and text go out; never the
// private question bank or a secret. Reads the question from stdin, prints the answer.
//   node tools/ask-deepseek.js [--model deepseek-reasoner|deepseek-chat] < question.md > answer.md
const fs = require("fs");
const path = require("path");
const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const key = ((env.match(/^DEEPSEEK_API_KEY=(.*)$/m) || [])[1] || "").trim();
if (!key) { console.error("DEEPSEEK_API_KEY is not in .env"); process.exit(2); }
const mi = process.argv.indexOf("--model");
const model = mi > 0 ? process.argv[mi + 1] : "deepseek-reasoner";
let q = "";
process.stdin.on("data", (d) => (q += d)).on("end", async () => {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, messages: [{ role: "user", content: q }], stream: false }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`DeepSeek ${r.status}: ${(j.error && j.error.message) || "error"}`); process.exit(1); }
  process.stdout.write(j.choices[0].message.content + "\n");
  if (j.usage) console.error(`(tokens: ${j.usage.prompt_tokens} in, ${j.usage.completion_tokens} out)`);
});
