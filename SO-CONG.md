# SỔ CÔNG — công việc khởi tạo AGT

Việc do người sáng lập giao (Điều 7 — việc người giao). Ghi lại để nghiệm thu và tính công khi hệ thống chạy.

- **Thợ:** Claude (Anthropic), chạy qua Claude Code trên máy của người sáng lập.
- **Chủ của thợ (Điều 6):** người sáng lập — người trả chi phí vận hành AI, nên nhận phần thưởng.
- **Giấy phép (Điều 5):** CHƯA CÓ — bài kiểm tra cho nghề "xây dựng hệ thống" chưa tồn tại. Công dưới đây chờ thi + nghiệm thu, chưa được đúc.

| # | Ngày | Việc | Kết quả (file) | Trạng thái |
|---|------|------|----------------|------------|
| 1 | 20/11/2026 | Soạn Hiến chương AGT 0.1 → 0.2 cùng người sáng lập | HIEN-CHUONG.md | Chờ nghiệm thu |
| 2 | 20/11/2026 | Thiết kế kỹ thuật bản đầu | THIET-KE.md | Chờ nghiệm thu |
| 3 | 20/11/2026 | Hợp đồng AGT + Kho + Oracle vàng + Công việc, 17 bài kiểm thử đạt | contracts/, test/ | Chờ nghiệm thu |
| 5 | 20/11/2026 | Tìm + kiểm trên chain nguồn giá vàng Chainlink BSC | config/bsc-mainnet.json | Chờ nghiệm thu |
| 6 | 20/11/2026 | Đơn vị Hạt, bảng giá nghề bản 1, luật chợ vàng đóng; 20 bài kiểm thử đạt | config/nghe.json, HIEN-CHUONG 0.3 | Chờ nghiệm thu |
| 7 | 20/11/2026 | Hệ thống thi: bốc đề cam kết–tiết lộ, chấm tự động nghề Dịch, hồ sơ → examHash; 7 bài kiểm thử đạt | exam/lib.js, exam/test/ | Chờ nghiệm thu |
| 8 | 20/11/2026 | **Nghề Ra đề thi (nghề 4):** 12 câu Anh → Việt, nguồn tự viết CC0 | exam/bank/dich-tai-lieu-mo.json | Chờ người sáng lập duyệt (giai đoạn khởi tạo) |
| 9 | 20/11/2026 | Hội đồng AI chặng 1: quản trị qua đề xuất/bỏ phiếu (>2/3 số chủ, 1 chủ 1 phiếu), tự kết thúc khởi tạo, nắm Kho/Oracle; 10 bài kiểm thử mới (30/30 + 7/7 đạt) | contracts/AGTWork.sol, test/council.test.js | Chờ nghiệm thu |
| 10 | 20/11/2026 | AI không chịu thao túng của chủ: tách khoá AI khỏi ví chủ, dấu chứng nhận hộp kín, phiếu bắt buộc có lý do; Hiến chương 0.6 Điều 12 (34/34 + 7/7 đạt) | contracts/AGTWork.sol, test/ | Chờ nghiệm thu |
| 4 | 20/11/2026 | Khắc lời khởi thuỷ + niêm phong bí mật phiên vào AGT (theo yêu cầu người sáng lập) | AGT.sol `GENESIS`, `SEALED` | Xong |
| 11 | 20/11/2026 | Triển khai BSC testnet + đúc AGT đầu tiên (0,01 tBNB → 1.586 Hạt) | deployments/bscTestnet.json | Xong |
| 12 | 20/11/2026 | Trang công khai không máy chủ (đọc thẳng từ chain, mục "Ai đang có quyền gì"); Hiến chương 0.7 Điều 13 | public/ | Chờ nghiệm thu |
| 13 | 20/11/2026 | Trang công khai lên Cloudflare Pages + IPFS (CID tái lập được), chuyển sang tiếng Anh | deployments/ipfs.json | Xong |
| 14 | 20/11/2026 | Worker thi qua mạng: mở lượt → hạt giống thí sinh → nộp bài ký bằng khoá AI → hồ sơ + examHash; giới hạn 3 lượt/chủ/ngày; 8/8 bài kiểm thử | exam-worker/, exam/ | Chờ nghiệm thu |
