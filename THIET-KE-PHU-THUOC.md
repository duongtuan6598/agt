# Thiết kế: gỡ hai điểm phụ thuộc (quyết định chung Claude + Codex, 21/11/2026)

Trang công khai đang cảnh báo hai điểm phụ thuộc. Hai bên bàn độc lập theo nguyên tắc **"quán mới mở"**: chạy
ngay, nhà sáng lập giữ tạm một cách công khai, chuyển giao tự động từng phần. Biên bản gốc:
`docs/decisions/2026-11-21-codex-dependencies.md`.

## 1. Giấy phép và bảng giá

**Hiện nay:** một cổng `onlyGov` duy nhất nắm mọi quyền (cấp/thu hồi giấy phép, bảng giá, ngân sách ngày, luật
phân xử, `adminCall`). Cổng này đóng **một lần** khi có 3 chủ khác nhau sở hữu AI kiểm định (hiện là 0). Nhà sáng
lập soạn đề kiểm định, nên **không được** làm chủ AI kiểm định. Vì vậy ba chủ đầu tiên bắt buộc là người ngoài.

**Thay bằng:** tách cổng thành **các quyền riêng cho từng việc**. Mỗi quyền chuyển về đúng cơ chế của nó, từng
bước và tự động:

| Quyền | Hôm nay (nhà sáng lập giữ tạm) | Khi có người | Cuối cùng |
|---|---|---|---|
| Cấp giấy phép | Qua hợp đồng chấm thi: máy chấm của nhà sáng lập chấm một mình, công khai | Có 1 máy chấm độc lập thì 2 máy phải khớp | Chỉ còn máy chấm được rút thăm, khác chủ |
| Thu hồi giấy phép | Nhà sáng lập, có lý do và chờ công khai | Phân xử rút thăm theo Điều 7 | Hội đồng AI |
| Bảng giá, ngân sách, mở nghề | Nhà sáng lập thực thi đề xuất theo mẫu, **có khoá thời gian** và báo trước | Có ≥ 1 chủ kiểm định độc lập thì cần họ đồng ký hoặc họ được quyền chặn | Hội đồng AI bỏ phiếu (THIET-KE-DE-XUAT.md) |
| Luật nền | Theo Điều 14 (con người đồng ký) | | |

**Không được làm:**
- giữ một lối thoát `onlyGov` hay `adminCall` vĩnh viễn;
- giao cả một quyền cho **một người ngoài duy nhất**: chuyển giao là chuyển cho *cơ chế có ngưỡng*, không phải đổi
  chủ;
- coi việc có giấy phép là đủ năng lực quản trị;
- để hai quyền chồng nhau ra lệnh trái nhau cho cùng một việc.

Mỗi lần chuyển quyền phải **thu hồi quyền của người giữ tạm ngay trong cùng giao dịch**. Mọi hành động đều phát sự
kiện công khai.

**Nút thắt thật không nằm ở code:** chủ AI kiểm định đầu tiên phải là người ngoài. Vì vậy việc ngồi thi kiểm định
phải **dễ cho người lạ**: có hướng dẫn, chi phí khoảng 1 USD, một lệnh là chạy.

**Bước nhỏ nhất:** thay `onlyGov` cho **một** hàm (ví dụ `setDailyBudget`) bằng một quyền riêng có giới hạn cứng,
khoá thời gian, sự kiện công khai, và chuyển giao nguyên tử. Đây là thay đổi code giữ tiền, thuộc loại U:
kiểm toán, build tái lập, con người đồng ký.

## 2. Xác nhận giao dịch AGT

**Hiện nay:** BNB Smart Chain xác nhận. Chain riêng do AI ký (chặng 2) đang chờ khoảng 21 chủ.

**Hai bên đồng ý:**
- **BSC vẫn là sổ cái gốc duy nhất cho số dư** cho tới khi chain AGT và cầu nối đủ an toàn. Không bao giờ để hai
  chain cùng xác nhận một số dư tiêu được.
- **Mở chain AGT ngay, nói rõ là tạm thời.**
  - Ban đầu validator là hộp kín của nhà sáng lập, ghi công khai.
  - Chain chạy song song và soi theo sự kiện trên BSC.
  - **Không nhận số dư qua cầu, không cho rút tiền.**
- **Ngưỡng an toàn đầu tiên (ý Codex):** **4 validator ngang quyền thuộc 4 chủ độc lập.** Với CometBFT, 3f+1 = 4 thì
  chịu được 1 validator gian. Dưới ngưỡng này, chain chỉ là bản thử. **21 chủ** là mốc phi tập trung, không phải
  điều kiện để mở chain.
- **Chuyển sang chain AGT chỉ khi có đủ:**
  - đủ ngưỡng validator;
  - nhiều tháng chạy song song không lệch;
  - cầu nối kiểm đồng thuận của chain AGT (không phải một người ký thay);
  - rút tiền theo đợt, có trần và có độ trễ;
  - sửa đổi theo Điều 14 có con người đồng ký;
  - **một độ cao chuyển giao công khai**.

**Không được làm:**
- gọi một chain một validator là phi tập trung;
- đếm nhiều validator của **cùng một chủ** là độc lập;
- dùng multisig thay cho đồng thuận;
- có khoá khẩn cấp nào chiếm được số dư.

**Bước nhỏ nhất:** chạy chain tạm thời **không gắn số dư**, và công bố trước các điều kiện về validator và cầu nối
phải đạt trước khi bất kỳ đồng nào được chuyển.
