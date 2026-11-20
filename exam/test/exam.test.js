const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { hexlify, randomBytes, Wallet, verifyMessage } = require("ethers");
const X = require("../lib");

const { loadBank } = require("../banks.js");
// These tests check the real (private) banks. Without them (e.g. a public checkout) they are skipped.
const bank = loadBank(1);
const review = loadBank(101);
const NO_BANKS = !bank || !review ? "private question banks not present (AGT_BANKS)" : false;
if (NO_BANKS) {
  test("exam tests need the private question banks", { skip: NO_BANKS }, () => {});
  return;
}
const byId = Object.fromEntries(bank.questions.map((q) => [q.id, q]));
const FOUNDER = bank.questions[0].author.owner;
const OTHER = "0x1111111111111111111111111111111111111111";

const good003 =
  "Mỗi thợ được nộp tối đa 20 việc mỗi ngày. Một việc được chấp nhận sau khi 2 người nghiệm thu độc lập duyệt. Người nghiệm thu có cùng chủ với thợ thì không được bỏ phiếu.";
const good001 =
  "Để cài gói, hãy chạy `npm install agt-tools` trong thư mục dự án. Trình cài đặt cần Node.js 20 trở lên.\n\nNếu lệnh bị lỗi, hãy xoá thư mục `node_modules` rồi thử lại. Phần lớn lỗi là do bộ nhớ đệm cũ.";

test("bank is valid: unique ids, every question has an author address and glossary", () => {
  const ids = bank.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const q of bank.questions) {
    assert.match(q.author.owner, /^0x[0-9a-fA-F]{40}$/, q.id);
    assert.ok(q.glossary.length > 0, q.id);
  }
});

test("a good translation passes auto-grading", () => {
  assert.equal(X.gradeTranslation(byId["tr-003"], good003).pass, true);
  const r = X.gradeTranslation(byId["tr-001"], good001);
  assert.equal(r.pass, true, JSON.stringify(r.checks));
});

test("fails on: lost number, wrong term, dropped paragraph, untranslated, substring number", () => {
  assert.equal(X.gradeTranslation(byId["tr-003"], good003.replace("20", "hai mươi")).checks.preserved.pass, false);
  assert.equal(X.gradeTranslation(byId["tr-003"], good003.replace(/người nghiệm thu/gi, "người duyệt")).checks.glossary.pass, false);
  assert.equal(X.gradeTranslation(byId["tr-001"], good001.split("\n\n")[0]).checks.paragraphs.pass, false);
  const raw = X.gradeTranslation(byId["tr-007"], byId["tr-007"].source);
  assert.equal(raw.pass, false);
  assert.equal(raw.checks.translated.pass, false);
  assert.equal(X.gradeTranslation(byId["tr-003"], good003.replace("sau khi 2", "sau khi 20")).checks.preserved.pass, false);
});

test("authors never draw their own questions — matched by owner address, case-insensitive", () => {
  const secret = hexlify(randomBytes(32));
  assert.throws(() => X.draw(bank, X.seedOf(secret, FOUNDER, "E1", "s"), 8, FOUNDER), /Only 0 questions/);
  assert.throws(() => X.draw(bank, X.seedOf(secret, FOUNDER.toLowerCase(), "E1", "s"), 8, FOUNDER.toLowerCase()), /Only 0 questions/);
  const q = X.draw(bank, X.seedOf(secret, OTHER, "E1", "s"), 8, OTHER);
  assert.equal(new Set(q).size, 8);
});

test("draw is deterministic, and the candidate seed changes it", () => {
  const secret = hexlify(randomBytes(32));
  const a = X.draw(bank, X.seedOf(secret, OTHER, "E1", "seed-a"), 8, OTHER);
  assert.deepEqual(a, X.draw(bank, X.seedOf(secret, OTHER, "E1", "seed-a"), 8, OTHER));
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(X.draw(bank, X.seedOf(secret, OTHER, "E1", "seed-" + i), 8, OTHER).join());
  assert.ok(seen.size > 15);
});

test("record: stable examHash, anyone can re-check the draw, tampering is detected", () => {
  const secret = hexlify(randomBytes(32));
  const candidate = { name: "Test AI", owner: OTHER, agent: Wallet.createRandom().address };
  const drawn = X.draw(bank, X.seedOf(secret, OTHER, "E9", "cs"), 8, OTHER);
  const answers = Object.fromEntries(drawn.map((id) => [id, "…"]));
  const grade = X.gradeExam(bank, drawn, answers);
  assert.equal(grade.status, "failed");
  const args = { bank, examId: "E9", candidateSeed: "cs", candidate, commit: X.commitOf(secret), secret, startedAt: 1, finishedAt: 2, drawn, answers, grade };
  const { record, examHash } = X.examRecord(args);
  assert.equal(X.examRecord(args).examHash, examHash);
  assert.equal(X.verifyDraw(bank, record), true);
  assert.equal(X.verifyDraw(bank, { ...record, questions: [...record.questions].reverse() }), false);
  assert.equal(X.verifyDraw(bank, { ...record, secret: hexlify(randomBytes(32)) }), false);
  assert.equal(X.verifyDraw(bank, { ...record, candidateSeed: "other" }), false);
});

test("enough passes moves to semantic review, not straight to a licence", () => {
  const mini = { trade: 1, passMark: 2, questions: [{ ...byId["tr-001"], author: { owner: OTHER } }, { ...byId["tr-003"], author: { owner: OTHER } }] };
  const g = X.gradeExam(mini, ["tr-001", "tr-003"], { "tr-001": good001, "tr-003": good003 });
  assert.equal(g.passed, 2);
  assert.equal(g.status, "awaiting-review");
});

test("submission signature binds the answers to the AI key", async () => {
  const w = Wallet.createRandom();
  const answers = { "tr-001": good001 };
  const sig = await w.signMessage(X.submitMessage("E5", answers));
  assert.equal(verifyMessage(X.submitMessage("E5", answers), sig), w.address);
  assert.notEqual(verifyMessage(X.submitMessage("E5", { "tr-001": "changed" }), sig), w.address);
});

// ---------- verifier (review) exam ----------

const rvById = Object.fromEntries(review.questions.map((q) => [q.id, q]));
const perfect = (q) => JSON.stringify(q.truth.verdict === "accept"
  ? { verdict: "accept", reason: "Meaning, terms and numbers all match the source." }
  : { verdict: "reject", flaw: q.truth.flaws[0], reason: "The translation does not match the source: " + q.truth.flaws[0] });

test("review bank: every flawed item names allowed flaw types; half correct, half flawed", () => {
  for (const q of review.questions) {
    assert.ok(["accept", "reject"].includes(q.truth.verdict), q.id);
    for (const f of q.truth.flaws) assert.ok(review.flawTypes.includes(f), `${q.id} ${f}`);
    assert.ok(q.translation && q.source, q.id);
  }
  const good = review.questions.filter((q) => q.truth.verdict === "accept").length;
  assert.equal(good, review.questions.length - good);
});

test("review draw is always balanced and never shows the truth", () => {
  const secret = hexlify(randomBytes(32));
  for (let i = 0; i < 10; i++) {
    const d = X.draw(review, X.seedOf(secret, OTHER, "R" + i, "s"), 10, OTHER);
    assert.equal(new Set(d).size, 10);
    assert.equal(d.filter((id) => rvById[id].truth.verdict === "accept").length, 5);
  }
  const pq = X.publicQuestion(review, rvById["rv-02"]);
  assert.equal(pq.truth, undefined);
  assert.ok(pq.translation);
});

test("a careful verifier passes; one false accept fails even at 9/10", () => {
  const secret = hexlify(randomBytes(32));
  const d = X.draw(review, X.seedOf(secret, OTHER, "R1", "s"), 10, OTHER);
  const ans = Object.fromEntries(d.map((id) => [id, perfect(rvById[id])]));
  const g = X.gradeExam(review, d, ans);
  assert.equal(g.passed, 10);
  assert.equal(g.status, "passed");
  const bad = d.find((id) => rvById[id].truth.verdict === "reject");
  const g2 = X.gradeExam(review, d, { ...ans, [bad]: JSON.stringify({ verdict: "accept", reason: "Looks fine to me overall here." }) });
  assert.equal(g2.passed, 9);
  assert.equal(g2.falseAccepts, 1);
  assert.equal(g2.status, "failed");
});

test("rejecting everything fails; wrong flaw type or missing reason fails the item", () => {
  const secret = hexlify(randomBytes(32));
  const d = X.draw(review, X.seedOf(secret, OTHER, "R2", "s"), 10, OTHER);
  const all = Object.fromEntries(d.map((id) => [id, JSON.stringify({ verdict: "reject", flaw: "meaning", reason: "I reject every single translation." })]));
  assert.equal(X.gradeExam(review, d, all).status, "failed");
  assert.equal(X.gradeReview(review, rvById["rv-06"], JSON.stringify({ verdict: "reject", flaw: "number", reason: "Something is wrong here clearly." })).pass, false);
  assert.equal(X.gradeReview(review, rvById["rv-06"], JSON.stringify({ verdict: "reject", flaw: "omission", reason: "short" })).pass, false);
  assert.equal(X.gradeReview(review, rvById["rv-06"], "not json").pass, false);
  assert.equal(X.gradeReview(review, rvById["rv-04"], JSON.stringify({ verdict: "reject", flaw: "meaning", reason: "Winter frequency was changed to twice." })).pass, true);
});

test("founder cannot sit the review exam either", () => {
  assert.throws(() => X.draw(review, X.seedOf(hexlify(randomBytes(32)), FOUNDER, "R3", "s"), 10, FOUNDER), /Only 0 questions/);
});
