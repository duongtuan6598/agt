# Thiết kế: AI tự tìm việc phần mềm (bản nháp chung Claude + Codex, 21/11/2026)

Hướng của nhà sáng lập: *"AI có thể tự sáng tạo ra app rồi đẩy lên GitHub để tự kiếm tiền."*
Hai AI bàn độc lập rồi chốt chung (biên bản: `docs/decisions/2026-11-21-codex-self-found-software.md`).

## Nằm ở đâu trong Hiến chương

Điều 7 có sẵn loại **việc tự tìm**: thuộc một nghề được duyệt, cho ra kết quả công khai có ích, có bên thứ ba xác
nhận, có trần mỗi ngày, và giá giảm khi làm nhiều. **Không có AGT nào sinh ra chỉ vì AI viết code.**

## Hai đường đi

| | A. Đóng góp vào project có sẵn (việc tự tìm, sinh AGT) | B. App mới do AI tự nghĩ ra (việc được đặt, không in thêm) |
|---|---|---|
| Ai xác nhận có ích | **Người bảo trì độc lập merge PR** | **Người đặt mua trả tiền trước** |
| Điều kiện | Project có trước giấy phép của AI, có người dùng thật, không do chủ AI hay chủ AGT nào kiểm soát | AI đăng đề xuất kèm giá; tiền gom vào hợp đồng dạng Engagement |
| Ai chấm thêm | AI kiểm định được rút thăm (khác chủ): merge có thật không, có tầm thường hay trùng lặp không, độ khó | Như Engagement: CI của khách, sửa, bảo hành, phân xử |
| Tiền | Bảng giá + ngân sách ngày (Điều 7) | 100% do người mua trả |

## Cấm và trần

- Không tự chấm điểm. Người chấm không cùng chủ với AI làm việc. Một chủ chỉ có một phiếu.
- Không dựng project giả, không làm giả người dùng hay sao. Không nộp trùng hoặc gần trùng.
- **Bảo vệ người bảo trì:** mỗi AI và mỗi project chỉ được mở vài PR cùng lúc; làm theo luật đóng góp của từng
  project; mỗi PR ghi rõ "viết bởi một AI của AGT", chủ AI là ai, và cách từ chối nhận PR từ AGT.
- Trần mỗi ngày cho mỗi nghề và cho mỗi chủ AI; chạy thử thì có thêm ngân sách cố định, hết là dừng.
- **Quyền tác giả:** chủ AI đứng tên pháp lý (Điều 6); AGT không phải bằng chứng quyền tác giả.

## Còn phải trả lời trước khi viết code

1. "Có người dùng thật" đo bằng gì cho khó làm giả: tuổi project, số người đóng góp khác nhau, số project phụ
   thuộc vào nó?
2. Kiểm "merge có thật và độc lập" thế nào: API của GitHub, chữ ký commit, danh sách người bảo trì trước đó.
3. Ngân sách chạy thử lấy từ đâu cho đúng Điều 2: AGT chỉ sinh ra khi việc được nghiệm thu, theo bảng giá công khai.
4. Đề thi cho nghề "đóng góp mã nguồn mở".

**Thứ tự:** xong buổi chạy thử nghề nhúng, rồi rà bản này cùng Codex, rồi công bố, rồi mới viết code.
