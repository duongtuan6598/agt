// The AI sits its exam from inside the box: answers come from the model (faked here — no API spend),
// the submission is signed with the box's own key, so the key that passes is the key in the box.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { ethers } = require("ethers");
const X = require("../../exam/lib.js");
const { sit } = require("../../exam-worker/client.js");
const { makeAnswerer, MODEL, REVIEW_SCHEMA } = require("../box/answer.js");
const E = require("../escrow.js");

// Minimal exam server: hands out a paper, checks the AI's signature on submit.
function fakeExamServer(paper) {
  const seen = {};
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (req.url === "/exams") { seen.agent = body.candidate.agent; return send({ ok: true, examId: "e1", commit: "0x" + "11".repeat(32) }); }
      if (req.url === "/exams/e1/seed") return send({ ok: true, examId: "e1", ...paper });
      if (req.url === "/exams/e1/submit") {
        const signer = ethers.verifyMessage(X.submitMessage("e1", body.answers), body.signature);
        seen.answers = body.answers;
        return signer === seen.agent ? send({ ok: true, examHash: "0x" + "22".repeat(32), status: "awaiting-review", passed: 1, total: 1 }) : send({ ok: false, error: "bad signature" }, 400);
      }
      send({ error: "nf" }, 404);
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, base: `http://127.0.0.1:${srv.address().port}`, seen })));
}

// A stand-in for client.beta.messages.create that records the request.
function fakeClient(reply) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => (calls.push(req), reply(req)) } } };
}

test("translation: the box's AI answers via the fixed model and signs with the box key", async () => {
  const paper = { task: "Translate each source passage from English into Vietnamese.", questions: [{ id: "q1", source: "Hello world", glossary: [] }] };
  const { srv, base, seen } = await fakeExamServer(paper);
  const client = fakeClient(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Xin chào thế giới" }] }));
  const k = E.derive(E.newMaster()); // keys exactly as the box derives them
  const r = await sit({ base, owner: "0x" + "ab".repeat(20), agentKey: k.agent.privateKey, name: "box", answersFor: makeAnswerer({ client, systemPrompt: "Charter rules" }) });
  srv.close();
  assert.equal(r.agent, k.agent.address);
  assert.equal(seen.answers.q1, "Xin chào thế giới");
  assert.equal(client.calls[0].model, MODEL);
  assert.equal(client.calls[0].system, "Charter rules");
  assert.equal(client.calls[0].fallbacks, "default");
});

test("review: structured JSON verdict; a model refusal becomes a safe reject, never an accept", async () => {
  const q = { id: "r1", source: "Pay $50", glossary: [], translation: "Trả 500 đô" };
  const ok = fakeClient(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"verdict":"reject","flaw":"number","reason":"50 became 500 in the translation"}' }] }));
  const a = await makeAnswerer({ client: ok, systemPrompt: "s" })(q, { task: "Review" });
  assert.equal(JSON.parse(a).verdict, "reject");
  assert.deepEqual(ok.calls[0].output_config.format, { type: "json_schema", schema: REVIEW_SCHEMA });
  const refused = fakeClient(() => ({ stop_reason: "refusal", content: [] }));
  const b = JSON.parse(await makeAnswerer({ client: refused, systemPrompt: "s" })(q, { task: "Review" }));
  assert.equal(b.verdict, "reject");
});
