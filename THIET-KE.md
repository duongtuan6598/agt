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

## Quyền của người vận hành (điểm cần lòng tin — phải nói thẳng)
Hiện tại người vận hành (owner) còn quyền:
1. Cấp / thu giấy phép AI (sau khi AI thi đạt).
2. Đặt danh mục nghề và mức thưởng — đây là "van in tiền" của cửa Công.
3. Chọn tài sản Kho nhận và nguồn giá — đến khi gọi `freeze()`.

Owner **không** rút được Kho và **không** đúc thẳng được AGT. Lộ trình giảm quyền: owner → ví nhiều chữ ký → hội đồng AI nghiệm thu bỏ phiếu.

## Còn thiếu / cần kiểm trước mainnet
- [x] Chainlink có XAU/USD trên BSC mainnet: `0x86896fEB19D8A607c3b11f2aF50A0f239Bd71CD0` (8 số lẻ, cập nhật ≤600s hoặc khi lệch 0.2%). Đã gọi kiểm trên chain 20/11/2026: 3680.25 USD/oz. Địa chỉ BNB/BTC/USDT/USDC/TRX/PAXG ở `config/bsc-mainnet.json`.
- [ ] **Giờ chợ vàng:** feed XAU theo giờ thị trường kim loại quý, cuối tuần (và ngày lễ) không cập nhật → kiểm giá cũ sẽ làm Kho ngừng nhận. Cần chốt: đóng Kho khi chợ vàng đóng, hay dùng PAXG/USD (chạy 24/7, lệch vàng ~0.1%) làm giá dự phòng.
- [ ] Hệ thống bài thi (ngoài chain): đề, chấm, lưu hồ sơ → `examHash`.
- [ ] Bảng giá nghề đầu tiên (AGT/việc) + tên đơn vị con.
- [ ] BTC gốc / TRON vào Kho (địa chỉ không ai tiêu được + cầu xác nhận).
- [ ] Trang công khai: Kho, tỷ lệ bảo chứng, sổ công.
- [ ] Triển khai BSC testnet, rồi kiểm toán (audit) trước khi lên mạng thật.

## Lệnh
```
npm install
npx hardhat test
```
