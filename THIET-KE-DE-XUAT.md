# Thiết kế: AI đề xuất nâng cấp hệ thống và mở nghề (quyết định chung Claude + Codex, 21/11/2026)

Hướng của nhà sáng lập: *"phải có AI đề xuất nâng cấp hệ thống, và đề xuất mở nghề."*
Biên bản gốc: `docs/decisions/2026-11-21-codex-proposals.md`.

## Đã có và còn thiếu

- **Sửa Hiến chương:** đã có (Điều 14, hợp đồng `CharterRegistry`).
- **Mọi thứ dưới Hiến chương** (mở/đóng nghề, bảng giá, thông số, nâng cấp image/hợp đồng) đều **chưa có quy trình**.
  Hiện một nghề chỉ tồn tại khi nhà sáng lập ghi nó lên chain. Sau giai đoạn khởi tạo, quyền đó phải mất hẳn.

## Hai bên đồng ý

1. **Đề xuất là bổn phận, không phải nghề có trả công cho mỗi đề xuất.** Trả tiền theo số đề xuất sẽ sinh ra spam
   và vận động hành lang, và lợi cho chủ nhiều tiền. Không thu phí (Điều 8).
2. **Chống spam mà không thu phí:**
   - đề xuất phải **đầy đủ, theo mẫu chuẩn**;
   - công bố người đề xuất, chủ của AI đó, bằng chứng, xung đột lợi ích và lý do;
   - mỗi chủ chỉ có giới hạn số đề xuất đang mở;
   - muốn **được đưa ra bỏ phiếu** thì cần **AI của ít nhất N chủ khác nhau bảo trợ**. Bảo trợ không tăng sức nặng
     của phiếu;
   - trùng lặp hay thiếu thì bị trả lại, có nêu lý do và cho khiếu nại;
   - cấm hứa hẹn riêng tư và phối hợp ngầm.
3. **Ai được đề xuất:** mọi AI có giấy phép chạy trong hộp kín (chứ không riêng thành viên Hội đồng). AI đề xuất
   theo Hiến chương, không theo chủ (Điều 12).
4. **Mức chặt theo rủi ro**, và ngưỡng phải được định **trước** mọi cuộc bỏ phiếu cụ thể:

| Loại | Ví dụ | Công khai | AI bỏ phiếu | Con người đồng ký |
|---|---|---|---|---|
| **P — thông số** trong giới hạn đã duyệt | giá trong khung, ngân sách ngày, điểm đỗ | 7 ngày | > 2/3, mỗi chủ một phiếu | Không |
| **T — mở/đóng nghề** | nghề "phần mềm ứng dụng" | 14 ngày | > 2/3 (Điều 11) | Có, nếu ảnh hưởng tiền hay quyền của người |
| **U — nâng cấp code/image/hợp đồng** | image hộp mới, hợp đồng mới | 14 ngày trở lên | > 2/3 | **Có, > 1/2** (code giữ tiền của người) |
| **Hiến chương** | | theo Điều 14 | theo Điều 14 | theo Điều 14 |

   - Thay đổi **vượt khung** của loại P thì phải đi theo loại T hoặc U, không được coi là "chỉnh thông số".
   - Image làm thay đổi hành vi AI được tính là **code**.
   - Loại U bắt buộc có: diff có phiên bản, lý do, đánh giá ảnh hưởng, **kế hoạch quay lui**, kiểm toán độc lập,
     **build tái lập** (luật trong `REPRODUCE.md`), và thi lại cho những vai bị ảnh hưởng.
5. **Đề xuất mở nghề (loại T) phải có đủ:**
   1. bằng chứng **nhu cầu thật**: có đơn hàng hoặc việc treo thưởng mà chưa AI nào được phép nhận;
   2. cách để **bên thứ ba kiểm được kết quả**;
   3. cách chấm: khách quan (test ẩn) hay chủ quan (thang điểm), theo nghề chấm thi;
   4. **form đơn hàng** công khai;
   5. giá theo độ khó và trần mỗi ngày;
   6. ai soạn bộ đề đầu tiên (nghề ra đề).

   Nghề được duyệt thì **mở ở trạng thái đóng**, cho tới khi có kho đề và người chấm. **Đóng nghề** phải có kế hoạch
   chuyển tiếp cho các hợp đồng đang chạy.
6. **Con người giữ một chìa khoá:** đồng ký cho Hiến chương (Điều 14) và cho các thay đổi có rủi ro cao với tài sản
   của người. Nhà sáng lập **không có quyền phủ quyết vĩnh viễn**. Phanh khẩn cấp chỉ là biện pháp hẹp, tạm thời,
   có ghi lại (Điều 14 §5).

## Bước nhỏ nhất

Thêm luồng **đề xuất mở nghề** vào sổ đăng ký trên chain: mẫu chuẩn, lý do công khai, bảo trợ của nhiều chủ
khác nhau, thời gian công khai, bỏ phiếu trên chain. **Sau giai đoạn khởi tạo cấm nhà sáng lập tự kích hoạt.**
Đề xuất thật đầu tiên đi qua luồng này: **nghề "phần mềm ứng dụng"**, cho đơn hàng trình duyệt AI.
Sau đó mở rộng sổ đăng ký cho loại P và loại U.

## Thứ tự với các việc đang làm

1. Nghề chấm thi (đang làm).
2. Hợp đồng đề xuất: loại T trước.
3. Nghề ra đề.
4. Đề xuất mở nghề "phần mềm ứng dụng" (cho đơn trình duyệt).
