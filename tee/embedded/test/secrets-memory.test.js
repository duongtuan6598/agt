// Client secrets sealed to the box, and the per-engagement memory (tee/embedded).
const test = require("node:test");
const assert = require("node:assert");
const E = require("../../escrow.js");
const S = require("../secrets.js");
const { EngagementMemory, memoryStore } = require("../memory.js");

const box = () => E.derive(E.newMaster());

test("a secret sealed to the box's client key opens only in that box, only for its engagement", () => {
  const k = box();
  const ctx = S.contextOf(97, "0xABCDEF", 7);
  const sealed = S.seal(k.client.pub.toString("base64"), "ghp_repoTokenOfTheClient", ctx);
  assert.equal(S.open(k.client.priv, sealed, ctx), "ghp_repoTokenOfTheClient");
  assert.throws(() => S.open(box().client.priv, sealed, ctx)); // another box
  assert.throws(() => S.open(k.seal.priv, sealed, ctx)); // the escrow key is a different key
  assert.throws(() => S.open(k.client.priv, sealed, S.contextOf(97, "0xABCDEF", 8)), /another engagement/);
  const moved = { ...sealed, context: S.contextOf(97, "0xABCDEF", 8) }; // relabelled: AAD no longer matches
  assert.throws(() => S.open(k.client.priv, moved, moved.context));
});

test("the client key comes back with the escrowed master, so sealed secrets survive a restart", () => {
  const master = E.newMaster();
  const ctx = "engagement:97:0x1:1";
  const sealed = S.seal(E.derive(master).client.pub.toString("base64"), "deploy-key", ctx);
  assert.equal(S.open(E.derive(master).client.priv, sealed, ctx), "deploy-key");
});

test("memory: encrypted at rest, chained, readable again after a restart, exportable at the end", async () => {
  const master = E.newMaster();
  const store = memoryStore();
  const ctx = "engagement:97:0x1:3";
  const m = new EngagementMemory(E.derive(master).memory, ctx, store);
  await m.append("decision", "Use FreeRTOS 11 with heap_4; tick 1 kHz", 1_700_000_000);
  await m.append("bug", "UART overrun at 921600 baud: DMA ring buffer too small", 1_700_100_000);
  for (const v of store.raw.values()) assert.ok(!v.includes("FreeRTOS") && !v.includes("UART")); // only ciphertext stored
  // names reveal nothing about the engagement (they are an HMAC under the memory key, then a sequence number)
  assert.ok([...store.raw.keys()].every((k) => /^mem:[0-9a-f]{32}:\d{8}$/.test(k) && !k.includes("engagement") && !k.includes(ctx)));
  const again = new EngagementMemory(E.derive(master).memory, ctx, store); // after a restart
  const all = await again.entries();
  assert.deepStrictEqual(all.map((e) => e.kind), ["decision", "bug"]);
  assert.ok((await again.context_()).includes("DMA ring buffer"));
  assert.equal((await again.export()).entries.length, 2);
  // another box, or another engagement, reads nothing
  assert.deepStrictEqual(await new EngagementMemory(E.derive(E.newMaster()).memory, ctx, store).entries(), []); // cannot even find it
});

test("memory: a dropped or reordered entry is detected", async () => {
  const store = memoryStore();
  const m = new EngagementMemory(E.derive(E.newMaster()).memory, "engagement:97:0x1:4", store);
  for (const t of ["a", "b", "c"]) await m.append("note", t);
  const keys = [...store.raw.keys()].sort();
  store.raw.delete(keys[1]);
  await assert.rejects(m.entries(), /gap or a stray entry|chain broken/);
});

test("memory: truncating the newest entries is caught by the anchored head; concurrent appends do not collide", async () => {
  const store = memoryStore();
  const m = new EngagementMemory(E.derive(E.newMaster()).memory, "engagement:97:0x1:5", store);
  await Promise.all(["a", "b", "c"].map((t) => m.append("note", t)));
  assert.equal((await m.entries()).length, 3);
  const anchor = await m.head(); // recorded on chain in the delivery report
  const keys = [...store.raw.keys()].sort();
  store.raw.delete(keys[2]); // storage rolls back to an older valid prefix
  await assert.rejects(m.entries({ anchor }), /rolled back/);
});

