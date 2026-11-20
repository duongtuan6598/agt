# ĐỀ XUẤT — Điều 14. Sửa đổi Hiến chương

*Người sáng lập đã duyệt ngày 20/11/2026. Đã đưa vào HIEN-CHUONG.md (bản 0.10) và CHARTER.md. Trên chain, quy trình được thực thi bởi `contracts/CharterRegistry.sol`. File này được giữ lại làm lịch sử.*

---

## Điều 14. Sửa đổi Hiến chương

**1. Những điều không bao giờ sửa được.** Không quy trình nào, không ai — người sáng lập, Hội đồng AI hay toàn bộ các chủ — được sửa, bỏ hay làm yếu những điều sau:

- **Hai nguồn sinh ra AGT** (Điều 2): chỉ Đổi và Công, không có nguồn thứ ba. Không cho vay hay tín dụng nào được đúc AGT.
- **Kho vĩnh viễn** (Điều 3): không ai rút được, không đổi ngược.
- **Thưởng thuộc về chủ** (Điều 6).
- **Không phí vận hành** (Điều 8): chỉ có tiền công đồng thuận, với trần cứng 10 Hạt.
- **AI không chịu thao túng của chủ, AI Hội đồng phải chạy trong hộp kín** (Điều 12).
- **Không ai chi phối, không có chìa khoá tổng** (Điều 13).
- **Chính khoản 1 này.**

Những điều này đã được viết cứng vào hợp đồng không có chủ. Khoản 1 cam kết thêm rằng **không ai được viết hợp đồng mới để lách chúng** rồi gọi đó là AGT.

**2. Quy trình sửa đổi.** Mọi sửa đổi khác phải đi đủ năm bước, theo thứ tự. Thiếu một bước là không có hiệu lực.

| Bước | Ai làm | Điều kiện |
|---|---|---|
| **a. Đề xuất** | Một AI Hội đồng (có hộp kín) | Văn bản sửa đổi **đầy đủ** (không chỉ ý tưởng), kèm lý do và đối chiếu với khoản 1. Mã băm văn bản được ghi lên chain. |
| **b. Công khai** | Mọi người | **30 ngày** để đọc và góp ý. Muốn sửa nội dung thì phải đề xuất lại từ đầu. |
| **c. AI biểu quyết** | Hội đồng AI | **Hơn 2/3** số chủ có AI hộp kín đồng ý. Mỗi phiếu kèm lý do công khai. |
| **d. Con người đồng ký** | Các chủ AI, ký bằng **ví chủ** (không phải khoá AI) | **Quá nửa** số chủ đồng ký trong vòng 14 ngày sau bước c. |
| **e. Chờ hiệu lực** | — | **7 ngày**, để ai không đồng ý kịp rút khỏi hệ thống. Sau đó mã băm Hiến chương mới được ghi lên chain. |

**3. Sửa đổi liên quan đến code** (hợp đồng mới, image hộp kín mới, chuỗi AGT) còn phải có thêm:
- **Kiểm toán độc lập** được công bố trước bước c.
- **Bản build tái lập được:** ai cũng tự build lại và ra đúng mã băm.
- **AI thi lại** để nhận giấy phép mới, khi code của hộp kín thay đổi (Điều 12).

**4. Hai chìa khoá, hai loại người giữ.** Bước c do **AI** quyết theo Hiến chương. Bước d do **con người** quyết bằng ví của mình. AI không thể tự sửa luật cho mình nếu con người không đồng ý. Con người cũng không thể sửa luật nếu AI thấy trái Hiến chương. Phần cứng và việc chạy code mới vẫn do con người làm, vì con người nắm chìa khoá vật chất.

**5. Khẩn cấp.** Khi có lỗ hổng bảo mật đang bị khai thác, Hội đồng AI (hơn 2/3) cùng quá nửa số chủ đồng ký được phép **tạm đóng Kho hoặc tạm ngừng nhận việc tối đa 14 ngày**. Họ không được sửa luật nào. Hết 14 ngày, mọi thứ tự mở lại, trừ khi một sửa đổi đã đi đủ quy trình ở khoản 2.

**6. Sửa chính Điều 14.** Phải đi đủ quy trình ở khoản 2, nhưng với ngưỡng cao hơn: AI **hơn 3/4**, con người **hơn 2/3**, công khai **60 ngày**. Khoản 1 thì không bao giờ sửa được.

**7. Ngôn ngữ.** Bản tiếng Việt là bản gốc. Bản dịch (tiếng Anh và các thứ tiếng khác) được thông qua cùng lúc, theo cùng quy trình.

**8. Trong giai đoạn khởi tạo.** Người sáng lập vẫn được sửa Hiến chương, nhưng phải công bố trước **7 ngày** và không được đụng khoản 1. Khi giai đoạn khởi tạo kết thúc, quyền này mất vĩnh viễn và chỉ còn quy trình ở khoản 2.

---

## Ghi chú kỹ thuật (để thực thi trên chain)

- **Một hợp đồng `CharterRegistry`, không có chủ.** Nó lưu mã băm Hiến chương đang có hiệu lực và các đề xuất (mã băm, ngày công khai, phiếu AI, chữ ký của chủ). Nó tự kiểm thời hạn 30, 14 và 7 ngày cùng các ngưỡng.
- **Phiếu AI** dùng đúng luật Hội đồng hiện có: khoá AI hộp kín, 1 chủ 1 phiếu.
- **Chữ ký con người** là chữ ký EIP-712 bằng ví chủ đã đăng ký trong giấy phép (`holder`), gửi cùng lúc lên chain.
- **Bộ kiểm tra hộp kín** sẽ đọc mã băm Hiến chương từ `CharterRegistry` thay vì từ file. Hộp kín nào mang Hiến chương cũ sẽ tự bị loại khi sửa đổi có hiệu lực.
- **Điều khoản không sửa được** đã được viết cứng trong AGT, Kho và Công việc; `CharterRegistry` không có quyền gì với chúng.
