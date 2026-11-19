const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { hexlify, randomBytes } = require("ethers");
const X = require("../lib");

const bank = require(path.join(__dirname, "..", "bank", "dich-tai-lieu-mo.json"));
const byId = Object.fromEntries(bank.cauHoi.map((q) => [q.id, q]));

const tot003 =
  "Mỗi thợ được nộp tối đa 20 việc mỗi ngày. Một việc được chấp nhận sau khi 2 người nghiệm thu độc lập duyệt. Người nghiệm thu có cùng chủ với thợ thì không được bỏ phiếu.";
const tot001 =
  "Để cài gói, hãy chạy `npm install agt-tools` trong thư mục dự án. Trình cài đặt cần Node.js 20 trở lên.\n\nNếu lệnh bị lỗi, hãy xoá thư mục `node_modules` rồi thử lại. Phần lớn lỗi là do bộ nhớ đệm cũ.";

test("kho đề hợp lệ: id không trùng, mỗi câu có tác giả và thuật ngữ", () => {
  const ids = bank.cauHoi.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const q of bank.cauHoi) {
    assert.ok(q.tacGia && q.tacGia.chu, q.id);
    assert.ok(q.thuatNgu.length > 0, q.id);
  }
});

test("bản dịch tốt đạt chấm tự động", () => {
  assert.equal(X.gradeTranslation(byId["dich-003"], tot003).dat, true);
  const r = X.gradeTranslation(byId["dich-001"], tot001);
  assert.equal(r.dat, true, JSON.stringify(r.checks));
});

test("trượt khi: mất con số, sai thuật ngữ, bỏ đoạn, chưa dịch", () => {
  const matSo = X.gradeTranslation(byId["dich-003"], tot003.replace("20", "hai mươi"));
  assert.equal(matSo.checks.giuNguyen.dat, false);
  const saiThuatNgu = X.gradeTranslation(byId["dich-003"], tot003.replace(/người nghiệm thu/gi, "người duyệt"));
  assert.equal(saiThuatNgu.checks.thuatNgu.dat, false);
  // "2" không được khớp nhầm vào "20": đổi 2 → 20 thì phải trượt vì thiếu số 2
  const soLan = X.gradeTranslation(byId["dich-003"], tot003.replace("sau khi 2", "sau khi 20"));
  assert.equal(soLan.checks.giuNguyen.dat, false);
  const boDoan = X.gradeTranslation(byId["dich-001"], tot001.split("\n\n")[0]);
  assert.equal(boDoan.checks.doan.dat, false);
  const chuaDich = X.gradeTranslation(byId["dich-007"], byId["dich-007"].nguon);
  assert.equal(chuaDich.dat, false);
  assert.equal(chuaDich.checks.daDich.dat, false);
});

test("người ra đề không bốc được câu của chính mình", () => {
  const secret = hexlify(randomBytes(32));
  assert.throws(() => X.draw(bank, X.seedOf(secret, "nguoi-sang-lap", "L1"), 8, "nguoi-sang-lap"), /Kho đề chỉ còn 0 câu/);
  const de = X.draw(bank, X.seedOf(secret, "chu-khac", "L1"), 8, "chu-khac");
  assert.equal(de.length, 8);
  assert.equal(new Set(de).size, 8);
});

test("bốc đề tất định theo hạt giống, khác lượt thì khác đề", () => {
  const secret = hexlify(randomBytes(32));
  const a = X.draw(bank, X.seedOf(secret, "chu-khac", "L1"), 8, "chu-khac");
  const b = X.draw(bank, X.seedOf(secret, "chu-khac", "L1"), 8, "chu-khac");
  assert.deepEqual(a, b);
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(X.draw(bank, X.seedOf(secret, "chu-khac", "L" + i), 8, "chu-khac").join());
  assert.ok(seen.size > 15);
});

test("hồ sơ thi: examHash ổn định, ai cũng kiểm lại được lượt bốc; sửa hồ sơ là lộ", () => {
  const secret = hexlify(randomBytes(32));
  const commit = X.commitOf(secret);
  const candidate = { ten: "AI thử", chu: "chu-khac" };
  const drawn = X.draw(bank, X.seedOf(secret, candidate.chu, "L9"), 8, candidate.chu);
  const answers = Object.fromEntries(drawn.map((id) => [id, "…"]));
  const grade = X.gradeExam(bank, drawn, answers);
  assert.equal(grade.trangThai, "truot");
  const args = { bank, examId: "L9", candidate, commit, secret, startedAt: 1, finishedAt: 2, drawn, answers, grade };
  const { record, examHash } = X.examRecord(args);
  assert.equal(X.examRecord(args).examHash, examHash);
  assert.equal(X.verifyDraw(bank, record), true);
  assert.equal(X.verifyDraw(bank, { ...record, de: [...record.de].reverse() }), false);
  assert.equal(X.verifyDraw(bank, { ...record, tietLo: hexlify(randomBytes(32)) }), false);
});

test("đủ số câu đạt thì chuyển sang nghiệm thu nghĩa, chưa phải cấp phép ngay", () => {
  const mini = {
    nghe: 1,
    datToiThieu: 2,
    cauHoi: [
      { ...byId["dich-001"], tacGia: { chu: "x" } },
      { ...byId["dich-003"], tacGia: { chu: "x" } },
    ],
  };
  const g = X.gradeExam(mini, ["dich-001", "dich-003"], { "dich-001": tot001, "dich-003": tot003 });
  assert.equal(g.soDat, 2);
  assert.equal(g.trangThai, "cho-nghiem-thu-nghia");
});
