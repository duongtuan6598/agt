// Hệ thống thi AGT (ngoài chain) — Hiến chương Điều 5.
// Bốc đề cam kết trước – tiết lộ sau, chấm tự động lớp 1, hồ sơ thi → examHash cấp giấy phép.
const { keccak256, toUtf8Bytes, concat, getBytes } = require("ethers");

// ---------- băm & JSON chuẩn ----------

/** JSON có khoá sắp xếp — cùng dữ liệu luôn ra cùng chuỗi, nên cùng dấu băm. */
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

const hashText = (s) => keccak256(toUtf8Bytes(s));
const hashJson = (o) => hashText(canonical(o));

// ---------- bốc đề kiểm chứng được ----------

/** Người tổ chức công bố commit = keccak(secret) TRƯỚC khi thi; sau thi công bố secret. */
const commitOf = (secretHex) => keccak256(secretHex);

/** Hạt giống bốc đề = keccak(secret ‖ chủ thí sinh ‖ mã lượt thi): không ai chọn được đề. */
function seedOf(secretHex, candidateOwner, examId) {
  return keccak256(concat([getBytes(secretHex), toUtf8Bytes(candidateOwner), toUtf8Bytes(examId)]));
}

/**
 * Bốc n câu: loại mọi câu do chính chủ thí sinh ra (người ra đề không thi đề mình),
 * rồi xáo Fisher–Yates bằng chuỗi keccak từ hạt giống.
 */
function draw(bank, seedHex, n, candidateOwner) {
  const pool = bank.cauHoi.filter((q) => q.tacGia.chu !== candidateOwner);
  if (pool.length < n) throw new Error(`Kho đề chỉ còn ${pool.length} câu thi được cho chủ này, cần ${n}`);
  const arr = pool.map((q) => q.id).sort();
  let h = seedHex;
  for (let i = arr.length - 1; i > 0; i--) {
    h = keccak256(h);
    const j = Number(BigInt(h) % BigInt(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ---------- chấm tự động lớp 1 (nghề Dịch) ----------

const paragraphs = (s) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const stripTrail = (s) => s.replace(/[.,;:!?)]+$/, "");

/** Những thứ bản dịch phải giữ nguyên: link, đoạn code, con số. */
function protectedTokens(src) {
  const urls = (src.match(/https?:\/\/\S+/g) || []).map(stripTrail);
  const code = src.match(/`[^`]+`/g) || [];
  const noCode = src.replace(/`[^`]+`/g, " ").replace(/https?:\/\/\S+/g, " ");
  const nums = noCode.match(/\d+(?:[.,:]\d+)*/g) || [];
  return { urls, code, nums };
}

const digitsOnly = (s) => s.replace(/(?<=\d)[.,](?=\d)/g, "");

function gradeTranslation(q, answer) {
  const a = (answer || "").trim();
  const src = q.nguon;
  const t = protectedTokens(src);
  const checks = {};

  const missingUrl = t.urls.filter((u) => !a.includes(u));
  const missingCode = t.code.filter((c) => !a.includes(c) && !a.includes(c.slice(1, -1)));
  // So nguyên từng con số (không so chuỗi con: "2" không được khớp nhầm vào "20").
  const aNums = new Set((digitsOnly(a.replace(/`[^`]+`/g, " ")).match(/\d+(?::\d+)*/g) || []));
  const missingNum = t.nums.filter((n) => !aNums.has(digitsOnly(n)));
  checks.giuNguyen = { dat: !missingUrl.length && !missingCode.length && !missingNum.length, thieu: [...missingUrl, ...missingCode, ...missingNum] };

  const lower = a.toLowerCase();
  const missingTerm = q.thuatNgu.filter(([, vi]) => !lower.includes(vi.toLowerCase())).map(([en, vi]) => `${en} → ${vi}`);
  checks.thuatNgu = { dat: !missingTerm.length, thieu: missingTerm };

  const ps = paragraphs(src).length, pa = paragraphs(a).length;
  checks.doan = { dat: ps === pa, nguon: ps, banDich: pa };

  const ratio = a.length / src.length;
  checks.doDai = { dat: ratio >= 0.8 && ratio <= 2.0, tiLe: Math.round(ratio * 100) / 100 };

  // Chưa dịch: tỉ lệ từ tiếng Anh (≥4 chữ, ngoài code/link) của nguồn còn nằm nguyên trong bản dịch.
  const plain = src.replace(/`[^`]+`/g, " ").replace(/https?:\/\/\S+/g, " ");
  const words = [...new Set((plain.match(/[A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase()))];
  const left = words.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(a.replace(/`[^`]+`/g, " ").replace(/https?:\/\/\S+/g, " ")));
  const leftRatio = words.length ? left.length / words.length : 0;
  checks.daDich = { dat: leftRatio < 0.25, conSot: Math.round(leftRatio * 100) / 100 };

  const dat = Object.values(checks).every((c) => c.dat);
  return { id: q.id, dat, checks };
}

// ---------- chấm cả bài & hồ sơ ----------

/**
 * Chấm một lượt thi. Đạt lớp 1 (tự động) chưa phải đạt hẳn: hồ sơ chuyển sang
 * nghiệm thu nghĩa (AI nghiệm thu có giấy phép, hoặc người sáng lập trong giai đoạn khởi tạo).
 */
function gradeExam(bank, drawn, answers) {
  const byId = Object.fromEntries(bank.cauHoi.map((q) => [q.id, q]));
  const ketQua = drawn.map((id) => gradeTranslation(byId[id], answers[id]));
  const soDat = ketQua.filter((r) => r.dat).length;
  return {
    ketQua,
    soDat,
    tong: drawn.length,
    datTuDong: soDat >= bank.datToiThieu,
    trangThai: soDat >= bank.datToiThieu ? "cho-nghiem-thu-nghia" : "truot",
  };
}

/** Hồ sơ thi đầy đủ → examHash ghi vào giấy phép trên chain. */
function examRecord({ bank, examId, candidate, commit, secret, startedAt, finishedAt, drawn, answers, grade }) {
  const record = {
    phienBan: 1,
    nghe: bank.nghe,
    khoDe: hashJson(bank),
    luotThi: examId,
    thiSinh: candidate, // { ten, chu }
    camKet: commit,
    tietLo: secret,
    batDau: startedAt,
    ketThuc: finishedAt,
    de: drawn,
    baiLam: Object.fromEntries(drawn.map((id) => [id, hashText(answers[id] || "")])),
    cham: { soDat: grade.soDat, tong: grade.tong, trangThai: grade.trangThai },
  };
  return { record, examHash: hashJson(record) };
}

/** Ai cũng kiểm lại được: secret khớp cam kết, và đề bốc ra đúng như hồ sơ. */
function verifyDraw(bank, record) {
  if (commitOf(record.tietLo) !== record.camKet) return false;
  const seed = seedOf(record.tietLo, record.thiSinh.chu, record.luotThi);
  const again = draw(bank, seed, record.de.length, record.thiSinh.chu);
  return canonical(again) === canonical(record.de);
}

module.exports = { canonical, hashText, hashJson, commitOf, seedOf, draw, protectedTokens, gradeTranslation, gradeExam, examRecord, verifyDraw };
