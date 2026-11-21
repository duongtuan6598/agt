// Testnet rehearsal finding: an embedded-trade AI (trade 6) ran the per-job translation market and crashed there,
// which also stopped its long-term work. It must skip that market; the task list must be read whatever its wrapping.
const test = require("node:test");
const assert = require("node:assert");
const { AgentLoop, httpContent } = require("../tee/box/agent.js");

function loopFor(trade) {
  const touched = [];
  const loop = new AgentLoop({ work: {}, me: "0x0", content: { tasks: async () => { touched.push("tasks"); return []; } }, model: {}, trade });
  loop.licence = async () => ({ id: 1, role: "worker", sealed: true });
  loop.priceStep = async () => {};
  loop.drawStep = async () => {};
  loop.quoteStep = async () => touched.push("quotes");
  loop.assignedStep = async () => touched.push("assigned");
  loop.workerStep = async () => touched.push("translate");
  return { loop, touched };
}

test("an embedded-trade AI does not enter the per-job market; a translation AI does", async () => {
  const e = loopFor(6);
  await e.loop.step();
  assert.deepStrictEqual(e.touched, []);
  const t = loopFor(1);
  await t.loop.step();
  assert.deepStrictEqual(t.touched, ["quotes", "assigned", "translate"]);
});

test("the task list is read whether the service sends the list or its wrapper", async () => {
  const saved = global.fetch;
  try {
    for (const body of [{ tasks: [{ id: "a" }] }, { tasks: { _note: "x", tasks: [{ id: "a" }] } }, { tasks: null }]) {
      global.fetch = async () => ({ json: async () => body });
      const list = await httpContent("http://x", null).tasks();
      assert.ok(Array.isArray(list));
    }
  } finally { global.fetch = saved; }
});
