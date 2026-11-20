# THIẾT KẾ KỸ THUẬT AGT — bản 0.1 (20/11/2026)

Chạy trên BNB Smart Chain (BEP20). Bám theo HIEN-CHUONG.md 0.2.

## 4 hợp đồng

| Hợp đồng | Vai trò | Điều |
|---|---|---|
| `AGT.sol` | Token AGT, 18 số lẻ. Không có chủ. Chỉ 2 cửa đúc: `mintFromVault` (chỉ Kho gọi) và `mintFromWork` (chỉ Công gọi). Đếm riêng `mintedByVault` / `mintedByWork`. Khắc `GENESIS` + `SEALED`. | 1, 2, 4, 9 |
| `AGTVault.sol` | Kho. Nhận BNB + token được duyệt, quy ra AGT theo giá vàng, đúc cho người thụ hưởng. **Không có hàm rút** (test danh sách trắng khoá điều này). `freeze()` khoá vĩnh viễn danh sách tài sản và nguồn giá. | 2, 3 |
| `ChainlinkGoldOracle.sol` | Giá = (token/USD) ÷ (XAU/USD) từ Chainlink, từ chối giá cũ. `freeze()` khoá nguồn giá. | 1 |
| `AGTWork.sol` | Giấy phép AI (Thợ / Nghiệm thu, kèm dấu băm bài thi), danh mục nghề (thưởng AGT, giới hạn/ngày, số phiếu), việc tự tìm, việc người giao (ký quỹ), khiếu nại, bỏ phiếu nghiệm thu. | 5, 6, 7, 8 |

## Luồng

**Đổi coin → AGT:** người dùng `approve` → `vault.deposit(token, số lượng, người nhận)` → token nằm vĩnh viễn trong Kho → AGT đúc cho người nhận.

**Việc người giao (bảo chứng 100%):** khách đổi coin ra AGT qua Kho → `work.assign(giấy phép thợ, AGT, đề bài, hạn)` ký quỹ → thợ `submitAssigned` → khách `accept`, hoặc im lặng quá `reviewWindow` (3 ngày) thì ai cũng `claim` được cho thợ → AGT chuyển về ví chủ thợ. Khách `dispute` → AI nghiệm thu bỏ phiếu: duyệt → trả thợ, bác → hoàn khách. Thợ trễ hạn → khách `reclaim`. Không đúc thêm đồng nào (chỉ người nghiệm thu khiếu nại được công qua cửa Công).

**Việc AI tự tìm (cửa Công):** thợ `submitSelf(giấy phép, nghề, dấu băm kết quả, link)` trong giới hạn/ngày → đủ `approvals` phiếu duyệt từ AI nghiệm thu khác chủ → đúc `reward` cho chủ thợ + `verifierReward` cho mỗi người bỏ phiếu đúng. Đủ phiếu bác → không đúc cho thợ.

**Chống gian:** người nghiệm thu không được trùng chủ với thợ hoặc khách; mỗi giấy phép bỏ 1 phiếu/việc; thu giấy phép thì hết làm việc được; việc tự tìm có trần/ngày.

## Hội đồng AI (Hiến chương Điều 11, chặng 1) — trong `AGTWork.sol`
Các việc quản trị — cấp/thu giấy phép, bảng giá nghề ("van in tiền" của cửa Công), luật khiếu nại, và cấu hình Kho/Oracle — chỉ chạy qua `onlyGov`:

- **Giai đoạn khởi tạo:** người sáng lập (owner) hoặc Hội đồng. Kho và Oracle được giao cho Hội đồng: `setGovTarget` → `transferOwnership(work)` → `adminCall(acceptOwnership)`.
- **Tự kết thúc khởi tạo:** ngay khi số CHỦ có giấy phép Nghiệm thu đạt `genesisExitVerifiers` (≥ 3, đặt lúc triển khai) → `genesisEnded = true`, owner = 0 **vĩnh viễn**. Từ đó mọi quản trị chỉ qua Hội đồng.
- **Đề xuất:** AI có giấy phép bất kỳ (Thợ hay Nghiệm thu) gọi `propose(giấy phép, hợp đồng đích, lệnh, lý do)`. Đích chỉ được là chính `AGTWork` hoặc hợp đồng trong `govTarget` — **không bao giờ là AGT**.
- **Bỏ phiếu:** `councilVote` — **mỗi CHỦ một phiếu** dù có bao nhiêu giấy phép; hạn 7 ngày.
- **Thông qua:** số chủ đồng ý > 2/3 số chủ đang có giấy phép (ngưỡng chống gian kiểu BFT) → ai cũng gọi `execute` được, chạy đúng 1 lần.

Không ai — kể cả Hội đồng — rút được Kho hay đúc thẳng AGT; Hội đồng chỉ đổi được luật chơi trong khuôn khổ code.

## AI không chịu thao túng của chủ (Hiến chương Điều 12)
**Trên chain (đã làm):**
- Giấy phép có 2 ví: `holder` (chủ — chỉ nhận thưởng) và `agent` (khoá AI — mọi hành động). `submitSelf`, `submitAssigned`, `vote`, `propose`, `councilVote` đều kiểm `msg.sender == agent`.
- Khoá AI ≠ ví chủ; không được là ví của bất kỳ chủ nào; mỗi khoá chỉ gắn 1 giấy phép mãi mãi (`licenseOfAgent`, `everHolder`).
- `attestHash` lưu dấu băm giấy chứng nhận hộp kín. Đổi code = giấy phép mới.
- Mọi đề xuất / phiếu Hội đồng / phiếu nghiệm thu phải có lý do (`NoReason`), phát qua sự kiện để ai cũng đọc được.
- Phiếu Hội đồng vẫn tính theo CHỦ (1 chủ 1 phiếu).

**Ngoài chain (cần làm trước khi mở Hội đồng thật):**
- Chạy AI trong TEE (Intel TDX / AMD SEV-SNP / GPU bảo mật). Khoá `agent` sinh BÊN TRONG hộp kín, không bao giờ ra ngoài.
- Hộp kín xuất báo cáo chứng nhận (attestation) gồm: dấu băm code vòng lặp AI, lệnh hệ thống, Hiến chương, địa chỉ `agent`. Lúc cấp phép, người cấp (khởi tạo) / Hội đồng kiểm báo cáo rồi ghi `attestHash`.
- Model AI có thể gọi qua API của nhà cung cấp; chủ không sửa được câu hỏi gửi đi vì lệnh nằm trong code đã chứng nhận.
- Sau này: kiểm báo cáo chứng nhận ngay trên chain (bộ kiểm DCAP on-chain), không phải tin người cấp.

**Chủ vẫn làm được (nói thẳng):** tắt AI (không bỏ phiếu được) — tức là **kiểm duyệt bằng cách im lặng**, nhưng không giả phiếu được. Ngưỡng > 2/3 tính trên số chủ đang có giấy phép nên AI im lặng = phiếu chống; Hội đồng có thể thu giấy phép AI vắng mặt lâu.

**Giới hạn còn lại (nói thẳng):**
- Hiện hợp đồng chưa tự kiểm được khoá AI có thật nằm trong hộp kín không — chỉ tin vào người kiểm `attestHash` lúc cấp phép.
- Người sáng lập có thể cấp giấy phép cho nhiều ví do mình giữ để kết thúc khởi tạo mà vẫn nắm Hội đồng. Code không chặn được; chỉ hồ sơ thi công khai (examHash) giúp người ngoài soi.
- Ngưỡng 2/3 tính trên số chủ **tại lúc thực thi**; phiếu của chủ bị thu giấy phép sau khi bỏ phiếu vẫn được tính.
- Chuyển AGT thông thường vẫn do validator BSC xác nhận — chặng 2 (chuỗi riêng) mới để AI ký khối.

## Còn thiếu / cần kiểm trước mainnet
- [x] Chainlink có XAU/USD trên BSC mainnet: `0x86896fEB19D8A607c3b11f2aF50A0f239Bd71CD0` (8 số lẻ, cập nhật ≤600s hoặc khi lệch 0.2%). Đã gọi kiểm trên chain 20/11/2026: 3680.25 USD/oz. Địa chỉ BNB/BTC/USDT/USDC/TRX/PAXG ở `config/bsc-mainnet.json`.
- [x] **Giờ chợ vàng — CHỐT cách 1:** chợ vàng đóng thì Kho đóng (Hiến chương Điều 1). Giá vàng cũ quá `xauMaxAge` = 3600s thì Kho từ chối; công việc vẫn chạy. Không dùng giá dự phòng.
- [x] Hệ thống bài thi (`exam/lib.js`) + Worker thi qua mạng `https://agt-exam.agtcoin.workers.dev` (`exam-worker/`, KV `AGT_EXAMS`, client mẫu `exam-worker/client.js`).
- [x] Đơn vị con **Hạt** = 1/1.000.000 AGT (`AGT.HAT`). Bảng giá nghề bản 1 ở `config/nghe.json`: Dịch tài liệu mở 500 Hạt/1.000 từ, Báo lỗi nguồn mở 5.000 Hạt/lỗi, Gắn nhãn dữ liệu mở 100 Hạt/100 mẫu.
- [ ] BTC gốc / TRON vào Kho (địa chỉ không ai tiêu được + cầu xác nhận).
- [ ] Trang công khai: Kho, tỷ lệ bảo chứng, sổ công.
- [ ] Triển khai BSC testnet, rồi kiểm toán (audit) trước khi lên mạng thật.

## Thi (Hiến chương Điều 5) — `exam/`
1. **Cam kết trước:** người tổ chức sinh `secret`, công bố `commit = keccak(secret)` trước giờ thi.
2. **Bốc đề:** thí sinh gửi `candidateSeed` SAU khi thấy commit; `seed = keccak(secret ‖ chủ thí sinh ‖ mã lượt ‖ candidateSeed)` (người tổ chức không 'mài' secret để chọn đề được) → loại mọi câu do chính chủ thí sinh ra → xáo Fisher–Yates → lấy `soCau` câu. Không ai chọn được đề.
3. **Chấm lớp 1 (tự động, nghề Dịch):** giữ nguyên link/code/con số (so nguyên từng số), đủ thuật ngữ bắt buộc, đúng số đoạn, độ dài hợp lý, không bỏ sót tiếng Anh chưa dịch. Đạt ≥ `datToiThieu` câu → chuyển **nghiệm thu nghĩa**.
4. **Chấm lớp 2 (nghĩa):** AI nghiệm thu có giấy phép đọc bản dịch; giai đoạn khởi tạo do người sáng lập duyệt.
5. **Tiết lộ sau:** công bố `secret`; ai cũng chạy `verifyDraw` để kiểm lượt bốc. Hồ sơ (đề, dấu băm bài làm, kết quả, dấu băm kho đề) → `examHash` → `grantLicense`.

**Bảo mật kho đề:** tiêu chí chấm công khai, nhưng nội dung câu hỏi chỉ công khai khi câu đã nghỉ hưu (mỗi hồ sơ vẫn ghi dấu băm kho đề để kiểm). ⚠️ Repo này hiện chứa kho đề — không đẩy lên chỗ công khai.

Kho đề đầu: `exam/bank/translation-en-vi.json` (tác giả ghi bằng địa chỉ ví người sáng lập) — 12 câu Anh → Việt, bốc 8, đạt ≥ 7, 60 phút. Tác giả: Claude (chủ: người sáng lập) → AI của người sáng lập không thi được bộ này.

## Lệnh
```
npm install
npm test   # hợp đồng (hardhat) + hệ thống thi (node:test)
```

## Điều kiện bắt buộc TRƯỚC KHI lên mạng thật
- [x] Tách danh tính (một phần, 20/11/2026): trang công khai → `agtcoin.pages.dev`, Worker thi + KV → `agt-exam.agtcoin.workers.dev`, trên tài khoản Cloudflare riêng của AGT. Còn: Pinata, dự án Google Cloud của hộp kín, ví mainnet mới.
- [ ] Kho đề đủ lớn (vài trăm câu, nhiều người ra đề).
- [ ] Ví triển khai mainnet mới, khoá không nằm dạng chữ thường trên laptop.
- [ ] Kiểm toán (audit) hợp đồng.
