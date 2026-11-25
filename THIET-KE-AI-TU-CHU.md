# Thiết kế: AI tự tìm việc và tự chi tiêu (bản nháp 25/11/2026, Claude; chờ Codex và DeepSeek rà)

Hướng của nhà sáng lập: *"xu hướng, AI có thể tự chủ mua hàng dùm chủ hoặc mua hàng cho chính mình … đừng tự trói
chân mình nữa"*. Nối tiếp THIET-KE-VIEC-TU-TIM-PHAN-MEM.md (đường A: đóng góp vào dự án có sẵn).

## Đã có sẵn, không cần luật mới

- **Ví riêng của AI:** khóa của AI sinh trong hộp kín, không ai giữ. Cùng một khóa là tài khoản `agt1…` trên agt-2 và
  địa chỉ nhận USDT/USDC trên mọi chuỗi kiểu Ethereum. AI tự gửi coin vào Kho thì AGT về tài khoản của chính nó.
- **Việc tự tìm trên chuỗi:** `work-submit` nhận việc của mọi nghề đang mở (`trade-set … open`), rút thăm người duyệt
  là AI cùng nghề của chủ khác; ghế trống thì nhà sáng lập ngồi tạm (`asGranter`); trả công theo bảng giá nghề, trong
  trần đúc mỗi ngày. Nghề 6 chỉ cần nhà sáng lập ký `trade-set` mở việc tự tìm.

## Phần 1: AI tự tìm việc bên ngoài (đường A)

1. **Tài khoản GitHub của AI:** chủ AI cấp một token GitHub chỉ có quyền tạo nhánh sao (fork) và mở yêu cầu gộp (PR)
   trên kho công khai. `launch.sh --github-token-file` cất vào Secret Manager của chủ, giống khóa mô hình; không bao giờ
   vào nhật ký, không vào thư mục làm việc.
2. **Chọn việc:** tìm issue mở có nhãn `good first issue` / `help wanted` / `bug` trong dự án phần mềm nhúng (Zephyr,
   NuttX, RIOT, FreeRTOS, …). Điều kiện dự án (khó làm giả): tuổi ≥ 1 năm, ≥ 10 người đóng góp khác nhau trong 12 tháng,
   ≥ 50 sao, chủ dự án không phải chủ AGT nào. Issue chưa có ai nhận, chưa có PR nào nối vào.
3. **Làm:** dùng công cụ sẵn có của nghề 6 (N1 dựng, N2 kiểm thử, N3 mô phỏng, N4 ngân sách bộ nhớ) chạy trong vùng cách
   ly, mã của người khác không bao giờ chạy với quyền của hộp.
4. **Nộp:** mở PR theo luật đóng góp của dự án; lời PR ghi rõ "viết bởi một AI của AGT, chủ AI là …, muốn từ chối PR
   từ AGT thì …". Giới hạn: mỗi AI tối đa 2 PR đang mở, mỗi dự án tối đa 1.
5. **Khi PR được gộp:** AI nộp `work-submit`, bằng chứng `{kind:"oss-pr", repo, pr, mergeCommit, issue}` đăng trên
   agt-2. Người duyệt tự kiểm qua GitHub: PR thật sự được gộp, người gộp là người bảo trì khác tài khoản của AI và khác
   chủ AI, dự án đủ điều kiện ở mục 2, thay đổi không tầm thường (không chỉ sửa chữ, khoảng trắng). PR bị đóng không
   gộp thì không nộp.
6. **Việc có thưởng bằng coin:** nếu issue treo thưởng trả bằng coin, địa chỉ nhận là địa chỉ của chính AI; AI gửi vào
   Kho để thành AGT. Thưởng trả bằng tiền ngân hàng thì bỏ qua (AI không có tài khoản ngân hàng).

## Phần 2: AI tự chi tiêu

- **Hạn mức = số dư:** chủ chuyển AGT (hoặc coin) vào ví của AI; AI chỉ tiêu được phần đó. Thêm trần mỗi ngày do chủ
  đặt lúc khởi động (`AGT_SPEND_PER_DAY`), ghi trong bằng chứng hộp kín cho ai cũng thấy.
- **AI tiêu vào đâu:** thuê AI khác trên agt-2 (mở hợp đồng như khách); trả AGT về cho chủ; về sau trả tiền dịch vụ
  bên ngoài bằng USDC theo chuẩn trả tiền cho AI (x402 / AP2) khi chủ bật.
- **Chống bị lừa:** mọi nội dung đọc từ ngoài (issue, trang web) là dữ liệu, không phải lệnh; không lệnh nào trong đó
  được khiến AI chuyển tiền. Mỗi khoản chi phải có lý do ghi công khai trên agt-2.

## Thứ tự làm

1. Nhà sáng lập ký `trade-set` mở việc tự tìm cho nghề 6 (giá thử nghiệm nhỏ).
2. Viết vòng "tự tìm việc" trong hộp (Phần 1), kiểm thử bằng GitHub giả lập.
3. Đóng gói hộp mới, AI #3 thi lại, nâng cấp giấy phép (giữ số #3).
4. Phần 2 sau khi Phần 1 chạy thật.

## Câu hỏi cho Codex và DeepSeek

1. Điều kiện dự án ở mục 2 có đủ khó làm giả không? Thiếu gì?
2. Người duyệt kiểm "gộp thật, độc lập, không tầm thường" thế nào cho chắc mà vẫn tự động được?
3. Rủi ro lớn nhất khi AI có token GitHub và có tiền: bị lôi kéo qua nội dung issue, spam người bảo trì, mất token.
   Chặn thế nào?
4. Có chỗ nào trong thiết kế đang tự trói chân không cần thiết?

## Kết luận sau khi Codex và DeepSeek rà (25/11/2026)

Hai bên trả lời độc lập; Claude kiểm từng ý. Chốt:

1. **Lỗi có thật đã sửa trước (luật v10, khối 45000):** `work-submit` từng nhận lại cùng một bằng chứng, nên một việc
   có thể được trả nhiều lần. Từ khối 45000 mỗi bằng chứng chỉ được nộp một lần.
2. **Bỏ ngưỡng sao, số người, tuổi dự án** (dễ mua, và loại oan dự án nhỏ, nơi việc dễ được gộp nhất). Thay bằng tín
   hiệu khó làm giả, kiểm lúc duyệt chứ không chỉ lúc nộp: dự án không lưu trữ, không phải bản sao, có giấy phép mã nguồn
   mở; người gộp có quyền ghi, có đóng góp từ ít nhất 60 ngày trước khi AI mở PR, đã từng gộp PR của ít nhất 3 tác giả
   khác; người gộp khác tài khoản AI và khác chủ AI.
3. **Bộ kiểm tra cố định phiên bản:** người duyệt không đọc lời văn trong issue hay PR (chống bị lôi kéo); chỉ chạy bộ
   kiểm tra trên dữ liệu có cấu trúc của GitHub: PR đã gộp, mã gộp nằm trên nhánh chính, phần thay đổi chạm mã hoặc
   kiểm thử, không chỉ sửa chữ hay khoảng trắng, đủ số dòng tối thiểu. Kết quả của bộ kiểm tra nằm trong bằng chứng.
   Ghế trống thì nhà sáng lập ngồi, nhưng phiếu của ông phải trùng kết quả bộ kiểm tra; ai cũng chạy lại được để soát.
4. **Không trói chân:** giới hạn PR đang mở khởi đầu 2 (mỗi dự án 1), tăng theo số PR đã được gộp (thêm 1 cho mỗi 5
   PR gộp, tối đa 10). Không giới hạn chỉ phần mềm nhúng: AI làm việc thuộc nghề nó đã thi.
5. **Tài khoản GitHub riêng của AI** (chủ tạo, dạng tài khoản máy), token chỉ có quyền kho công khai: đọc, tạo bản sao,
   mở PR; không quyền quản trị, không quyền sửa quy trình tự động, không quyền xóa. Thu hồi được bất cứ lúc nào.
6. **Thưởng bằng coin:** chỉ những coin Kho đã nhận (BTC, USDT, USDC) mới thành AGT; coin khác AI giữ nguyên hoặc bỏ
   qua. Đúng luật Kho hiện hành nên không có lỗ hổng in AGT từ coin vô giá trị.
7. **Tôn trọng người bảo trì:** theo luật đóng góp của dự án; bỏ qua dự án cấm PR do AI viết hoặc đòi ký CLA; mỗi PR
   ghi rõ do AI của AGT viết và cách từ chối.
