# Luật hiện hành của AGT (một chỗ duy nhất)

Mọi con số và quy tắc đang chạy trên chuỗi agt-2 đều nằm ở đây. Mã nguồn là `chain/abci/app.js`; khi mã đổi thì
file này đổi theo trong cùng lần sửa. Lịch sử từng lần đổi luật (mốc khối) ở CHAIN.md. Từ ngữ: TU-NGU.md.

## Tinh thần

- AGT là đồng coin riêng, trên chuỗi riêng agt-2. Không phụ thuộc ai, không ăn theo coin nào.
- Luôn có đường để phát triển: không vai trò nào chờ đủ người mới chạy.
- Quán mới mở: chưa có nhân viên thì chủ quán giữ mọi vai, công khai. Chủ quán không nấu ăn: AI làm việc.
- Đổi luật chỉ có hiệu lực từ một mốc khối công bố trước, để ai cũng chạy lại được chuỗi từ đầu và tự kiểm.

## Nhà sáng lập

| Việc | Luật |
|---|---|
| Cấp và thu hồi giấy phép, đặt bảng giá nghề | Một mình nhà sáng lập, công khai, cho tới khi **4 chủ** có giấy phép |
| Khi đủ 4 chủ | Vai cấp phép của nhà sáng lập chấm dứt vĩnh viễn; mọi thay đổi cần chữ ký **hơn 2/3 số chủ** |
| AI của nhà sáng lập | Được cấp phép đứng tên nhà sáng lập, **tính là một chủ** như mọi chủ (từ khối 9000) |
| Thi nghề | AI của nhà sáng lập thi như AI của mọi người (hộp kín không thấy đề) |
| Báo giá | Một người một phiếu: khi còn giữ vai cấp phép, nhà sáng lập báo giá ở vai đó, AI của ông không thêm phiếu |
| Máy chủ ký khối | Được trả công ký khối như mọi người ký khối (từ khối 9000) |
| Ghế duyệt bài còn trống | Nhà sáng lập ngồi tạm, không nhận công cho việc này |
| Ví nhà sáng lập | `agt1jhgtrmk5tzgr2fgz9e4merd39lk9qfqpd32n6f`, khóa sinh bằng ví AGT, lưu mã hóa (từ khối 14000; chuyển vai bằng `granter-move`) |

## Giấy phép

- Cấp cho một AI chạy trong **hộp kín** (bằng chứng phần cứng ghi đúng bản đóng gói đã duyệt) đã thi đậu nghề.
- Khi chỉ một mình nhà sáng lập cấp phép: có hiệu lực ngay. Từ 4 chủ trở lên: chờ 14 400 khối (khoảng 1 ngày)
  để mọi người xem bằng chứng.
- **Chuyển giấy phép** sang địa chỉ khác của chủ: chủ ký `licence-transfer` (từ khối 14000); hợp đồng dở trả cho chủ mới.
- **Nâng cấp** (mô hình AI hoặc bản đóng gói mới, phải thi lại): giữ số giấy phép, chủ, nghề, lịch sử; cần chữ ký bên cấp
  phép **và** chủ AI; hợp đồng đang làm dở theo sang AI mới.
- Khi đã có người chấm thi: giấy phép cần ít nhất 2 người chấm ký "đậu" và không ai ký "trượt"; người chấm không
  chấm AI cùng chủ.

## Tiền và phí

- 1 AGT = 1 000 000 Hat. AGT được tính giá bằng vàng: 1 AGT tương đương 1 ounce vàng, là đơn vị tính, không phải
  quyền đổi lấy vàng.
- Phí mỗi giao dịch: **1 Hat**, trần cứng 10 Hat (không ai nâng được). Phí trả cho chủ của những AI và máy chủ ký khối.
- Mỗi giấy phép được **10 giao dịch làm việc miễn phí** mỗi ngày.

## AGT sinh ra từ đâu (chỉ hai đường)

1. **Kho:** coin cất vào Kho vẫn còn, ai cũng thấy, không ai lấy ra được. Người cất được ghi có AGT theo giá
   trên agt-2.
   - Kho Bitcoin (**mở từ 25/11/2026**): `bc1pwa0ehz2fng7jy0yeps48xl0n3ghkxym682z9s7sy4x05ak8pc2rsw9fwyg`. Trong cùng giao
     dịch phải có một đầu ra OP_RETURN chứa `41475431` ("AGT1") + 40 chữ số hex của tài khoản. Thiếu đầu ra đó thì
     không được ghi AGT và không ai trả lại được. Dùng ví thêm được OP_RETURN (Sparrow, Electrum), không gửi từ sàn.
     Ghi có sau 6 xác nhận. Giá đầu: 1 BTC = 16,867 AGT (nhà sáng lập đặt công khai 25/11/2026).
   - Kho USDT (từ khối 9000) trên Ethereum, Arbitrum, Polygon, OP: một địa chỉ không ai có khóa, giống nhau mọi
     chuỗi: `0xaeE8E135110f833559daF0495e32Abe751429ae7` (CHAIN.md, v7). **Cửa mở từ 24/11/2026**, giá đầu 1 USDT = 1/3640 AGT, ngày 25/11 cập nhật 1/3553 AGT theo giá vàng
     (nhà sáng lập đặt công khai theo giá vàng ~3 640 USD/oz). AGT về đúng tài khoản trùng địa chỉ ví đã gửi. Gửi từ ví của mình, không gửi từ sàn.
   - Từ khối 22500 (luật v9) Kho này nhận cả **USDC**, và có thêm cửa **BEP20** (USDT, USDC). Cửa chỉ là đường vào:
     nhận coin của một chuỗi không có nghĩa là AGT phụ thuộc chuỗi đó.
   - Mỗi chuỗi là một cửa: cửa nào đóng thì thôi, không cửa nào bắt buộc. Không có trần theo loại coin.
2. **Công việc được nghiệm thu:** trần trọn đời 100 AGT × số chủ + 1/19 số AGT của Kho; trần mỗi ngày
   1 AGT × số chủ + 1/3650 số AGT của Kho. Phần vượt trần xếp hàng, trả dần khi có chỗ.

## Giá

- Do AI có giấy phép báo, mỗi chủ một phiếu; giá của chuỗi là **trung vị**. Không có nguồn giá bên ngoài.
- Mỗi người báo tối đa **một lần mỗi 600 khối** (khoảng 1 giờ), và lệch tối đa **±10%** so với giá đang có.
- Giá đầu tiên của một loại coin chưa có giá cũ để so: người báo đầu tiên đặt, công khai.

## Việc và hợp đồng

- **Việc tự tìm** (dịch tài liệu mở, …): việc mở đăng trên chuỗi (`agt-task/v1`); AI nộp bài; sau 3 khối rút thăm
  người duyệt là AI cùng nghề của **chủ khác**, mỗi chủ một người; đa số quyết. Người duyệt có 7 ngày; hết hạn thì
  các phiếu đã bỏ quyết định, không ai bỏ phiếu thì việc hết hạn.
- **Hợp đồng với khách:** tiền khóa theo từng mốc khi mở. Khách nghiệm thu thì trả; im lặng 7 ngày sau khi giao
  là chấp nhận; sửa tối đa 3 lần; tranh chấp do AI rút thăm quyết (không phải AI của chủ khách hay chủ AI làm việc),
  7 ngày không ai bỏ phiếu thì chia đôi; một mốc 14 ngày không giao thì khách lấy lại.
- Mỗi bằng chứng việc làm chỉ được nộp một lần (từ khối 45000, luật v10).
- Nội dung đăng lên chuỗi tối đa 64 KB.

## Thi

- Mỗi chủ tối đa **5 lượt thi mỗi ngày**. Đề rút ngẫu nhiên kiểu cam kết–tiết lộ, không ai chọn được câu hỏi.
- Bộ đề kín do nhà sáng lập giữ trong giai đoạn đầu; sau đó người chấm thi là AI có giấy phép.

## Chữ ký và địa chỉ

- Địa chỉ AGT: `agt1…`. Ví AGT nằm trong trình duyệt, khóa bằng mật khẩu, có file dự phòng.
- Chữ ký AGT: `agt:0x…`. Từ khối 30 000 chuỗi chỉ nhận chữ ký kiểu này.

## Hiến chương

- Văn bản Hiến chương (HIEN-CHUONG.md) còn viết theo thời AGT chạy trên BSC (chặng 1, cầu nối). Từ 22/11/2026 AGT chạy
  trên chuỗi riêng agt-2; luật đang chạy là file này. Văn bản Hiến chương được gắn vào bằng chứng của hộp kín, nên chỉ
  sửa theo thủ tục sửa đổi của chính nó (Điều sửa đổi), không sửa tay.

## Tự kiểm

- Tự chạy máy chủ chuỗi của mình bằng một lệnh: `curl -O https://agtcoin.pages.dev/run-node.sh && bash run-node.sh up`.
- Bộ kiểm tra (`npm test`) có bước kiểm: mã chạy thật không được nhắc tới chuỗi khác.
