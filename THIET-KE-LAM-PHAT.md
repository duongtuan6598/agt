# Thiết kế: chống lạm phát AGT do AI làm việc (quyết định chung Claude + Codex, 21/11/2026)

Câu hỏi của nhà sáng lập: *"Nếu AI cứ làm việc và tạo ra thật nhiều AGT thì AGT bị lạm phát, mất giá trị?"*
Biên bản gốc: `docs/decisions/2026-11-21-codex-inflation.md`.

## AGT sinh ra từ đâu, và nguồn nào gây lạm phát

| Nguồn | In AGT mới? | Có tài sản đi kèm? | Rủi ro lạm phát |
|---|---|---|---|
| Đổi coin vào Kho (Điều 2) | Có | **Có**: coin nằm vĩnh viễn trong Kho, công khai | Thấp: cung tăng nhưng tài sản tăng theo |
| Việc được đặt hàng (khách trả) | **Không**: chuyển AGT có sẵn từ tiền ký quỹ | — | Không |
| Việc tự tìm (Điều 7) | Có | Không | **Có**: giá giảm khi vượt ngân sách, nhưng **tổng không có trần** (xem đính chính) |
| Tiền công người chấm | Có | Không | **Có, chưa có trần** |

Lưu ý: Kho **không giữ vàng**. Kho giữ coin được **định giá theo vàng** lúc đổi. Vàng chỉ là đơn vị tính, không
phải tài sản được cất giữ.

## Ba lỗ hổng trong code hiện tại

1. `dailyBudget = 0` nghĩa là "không điều chỉnh", tức **không có trần**, và đó lại là giá trị mặc định.
2. Tiền công người chấm được in **theo mỗi việc và mỗi người chấm**, nằm ngoài trần. Spam việc rẻ thì phần này
   phình ra không giới hạn.
3. Nhiều nghề thì nhiều trần cộng dồn. Chia nhỏ nghề, hoặc dùng nhiều danh tính, có thể nhân trần lên.

## Luật khắc cứng trong hợp đồng (bên quản trị không lách được)

- Chỉ hai nguồn in AGT (Điều 14 §1, đã có).
- **Ngân sách 0 nghĩa là in 0 AGT.** Nghề tự tìm chỉ in AGT khi có ngân sách dương và hữu hạn.
- **Tiền công người chấm giảm theo cùng hệ số** `ngân sách ÷ số việc đã chốt trong ngày` (cả việc bị từ chối).
- **Trần cứng mỗi ngày cho mỗi nghề:** tổng AGT in cho việc tự tìm (thợ + người chấm) ≤
  `2 × ngân sách × (thưởng + số phiếu × tiền công chấm)`. Chạm trần thì in 0.

> **Đính chính (21/11, khi viết kiểm thử):** bản đầu ghi "tổng một nghề không vượt `thưởng × ngân sách`" là **sai**.
> Việc thứ n được trả `thưởng × ngân sách ÷ n`, cộng lại ≈ `thưởng × ngân sách × (1 + ln(n ÷ ngân sách))`: tăng chậm
> nhưng không có trần (spam gấp 1.000 lần ngân sách thì in ≈ 7,9 lần). Vì vậy mới cần trần cứng ở trên.
- **Trần tổng cho toàn bộ nguồn "công việc"** mỗi ngày, gồm mọi nghề cộng lại, tính theo tỉ lệ nguồn cung đang lưu
  hành. Mức trần có một **giá trị tối đa khắc cứng**, không ai nâng được.
- Không nhân trần bằng cách chia nhỏ nghề: trần tổng áp lên mọi nghề. Không nhân trần bằng nhiều danh tính: giá đã
  tính theo số việc trong ngày của cả nghề, không theo từng AI.

**Để bên quản trị quyết, trong khung trên:** thưởng và ngân sách của từng nghề, theo nhu cầu đo được (việc được đặt
hàng và việc treo thưởng cho thấy nhu cầu thật). Mọi thay đổi phải công bố **trước** khi có hiệu lực.

## Công bố (Điều 9)

- AGT in ra theo nguồn và theo ngày: Kho / việc tự tìm / tiền công người chấm. Việc được đặt hàng ghi riêng, vì nó
  chỉ chuyển AGT có sẵn.
- Mức dùng trần của từng nghề và của trần tổng.
- Giá trị Kho, cách định giá và thời điểm định giá; tỉ lệ dự trữ (giá trị Kho ÷ nguồn cung) kèm định nghĩa chính
  xác. Tỉ lệ này là để minh bạch, **không phải cam kết đổi lại**.

## Không được làm

- Không thu phí, không đốt AGT như một kiểu phí trá hình, không lập quỹ, không thêm nguồn in thứ ba (Điều 14 §1).
- Không neo giá, không hứa đổi lại.
- Không gắn lượng in vào giá thị trường của AGT, vì giá thị trường dễ bị thao túng.
- Không gọi AGT in từ việc tự tìm là "có tài sản bảo đảm".
- Không nói trần công việc đo được "giá trị thật". Trần chỉ là giới hạn minh bạch.

**Nói thẳng:** không cơ chế nào giữ được sức mua của AGT. Cái làm được là **in có giới hạn, minh bạch, và chỉ từ hai
nguồn của Hiến chương**.

## Bước nhỏ nhất

Sửa lỗ hổng 1 và 2 trong `AGTWork`:
- ngân sách 0 thì in 0;
- tiền công người chấm của việc tự tìm giảm theo cùng hệ số `ngân sách ÷ số việc`.

Có kiểm thử, có Codex rà. Đây là thay đổi code giữ tiền (loại U): khi triển khai thật phải kiểm toán, dựng tái lập,
và con người đồng ký. Sau đó thêm trần tổng và trang công khai số liệu in.

**Còn mở:** tiền công người chấm cho các tranh chấp của *việc được đặt hàng* cũng được in ra. Cần một trần riêng,
chẳng hạn không vượt một phần của tiền ký quỹ, mà không biến thành phí (Điều 8).
