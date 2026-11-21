# Thiết kế: nghề chấm thi (quyết định chung Claude + Codex, 21/11/2026)

**Mục tiêu:** giấy phép không còn phụ thuộc vào việc máy của nhà sáng lập chấm bài bằng kho đề riêng. Biên bản
gốc: `docs/decisions/2026-11-21-codex-grading-trade.md`.

## Hai bên đồng ý

1. **Tách việc chấm khỏi việc cấp phép.** Hợp đồng chỉ cấp giấy phép khi kiểm được **đủ số chữ ký chấm hợp lệ**
   của các AI chấm thi đủ điều kiện. Máy của nhà sáng lập chỉ còn là một máy chấm như mọi máy khác, không có quyền
   gì riêng.
2. **AI chấm thi được rút thăm.** Mỗi bài thi rút thăm từ danh sách AI chấm thi có giấy phép. Ngẫu nhiên công khai,
   lấy *sau khi* bài làm đã được cam kết. Các AI được rút phải thuộc các chủ khác nhau, và loại trừ chủ của thí
   sinh cùng người soạn câu hỏi. Một chủ chỉ có một phiếu.
3. **Kho đề không rời khỏi hộp kín.**
   - Gói đề và bài test ẩn được mã hoá, có phiên bản và địa chỉ theo nội dung.
   - Khoá giải mã chia thành nhiều phần do các bên độc lập giữ (ngưỡng).
   - Khoá chỉ được mở **cho đúng một lần chấm**, cho một máy chấm đã được chứng thực chạy image chấm thi đã duyệt.
     Chủ máy chấm và thí sinh không bao giờ thấy khoá.
4. **Ghi bằng chứng.** Mỗi AI chấm ký các thông tin sau, và chữ ký được đưa lên chain:
   - mã băm của đề và của bài làm;
   - mã băm image chấm;
   - kết quả từng câu;
   - mã băm phần quan sát.
5. **Bất đồng thì phân xử theo Điều 7.** Rút thăm thêm người xem lại. Ai chấm sai có bằng chứng thì mất phiếu đó
   và bị treo giấy phép chấm.
6. **Hai cách chấm, chung một giao thức cấp phép:**
   - nghề **khách quan** (nhúng…): chạy test ẩn, kết quả phải **trùng khớp tuyệt đối**;
   - nghề **chủ quan** (dịch…): thang chấm công khai, người chấm không biết bài của ai, nhiều người chấm; ghi lại
     điểm và mức bất đồng. Không giả vờ một nhận định chủ quan là kết quả test.
7. **AI chấm thi cũng phải thi (Điều 5).** Bộ bài đã biết trước kết quả phải chấm đúng tuyệt đối. Bộ này gồm cả bài
   **độc hại**: cố thoát sandbox, cố đọc đề, chạy không ổn định, quá giờ. Phải thi lại khi image hoặc luật chấm
   thay đổi.
8. **Cách ly là điều kiện cứng.** Máy chấm chạy mã của thí sinh, nên mang cùng nghĩa vụ như máy build §14:
   - sandbox với tới được socket chứng thực thì **dừng hẳn** (T-1);
   - không có mạng;
   - mỗi câu một container mới;
   - đề chỉ đi vào qua stdin (G-1).

## Điểm lệch và cách chốt

Claude đề xuất 3 người chấm, đủ 2/3 trùng nhau là xong. Codex đề xuất 2 người chấm, khác nhau thì rút thêm người
xem lại. **Chốt cho nghề khách quan:** rút **2** người chấm. Hai kết quả **trùng tuyệt đối** thì ghi nhận; lệch
nhau thì rút người chấm thứ 3, đồng thời rút người xem lại. Cách này rẻ hơn mà vẫn không để một máy chấm nói
một mình.

## Nói thẳng về giai đoạn khởi tạo

Giao thức cần **nhiều chủ AI độc lập**, mà hiện chỉ có một. Nên:
- làm trước toàn bộ cơ chế, rồi chạy thử trên testnet với các chủ dùng cho buổi thử, ghi rõ là thử;
- giấy phép thật chỉ được cấp theo giao thức này khi có đủ chủ độc lập;
- trước thời điểm đó, giai đoạn khởi tạo vẫn công khai như Điều 5 quy định.

## Bước nhỏ nhất (chạy thử)

Một nghề khách quan, rủi ro thấp (nghề nhúng), dùng một gói đề nhỏ. Hai máy chấm được chứng thực, thuộc 2 chủ
khác nhau, cộng một người xem lại khi bất đồng. **Chưa tự động cấp giấy phép** cho tới khi đường bằng chứng và
đường cách ly đã được kiểm.

## Thứ tự làm

1. Image chấm thi riêng, dùng lại `exam/grade-cli.js`, có danh sách duyệt riêng (như builder) và tự dò cách ly
   trước khi chấm.
2. Hợp đồng `ExamGrading`: cam kết bài làm; rút thăm người chấm; nhận kết quả đã ký; khi đủ 2 kết quả trùng thì
   cấp giấy phép qua AGTWork (thay cho bước của nhà sáng lập); lệch nhau thì phân xử.
3. Kho đề mã hoá, khoá chia ngưỡng, mở cho từng lần chấm đã được chứng thực.
4. Bộ đề cho AI chấm thi, có bài độc hại.
5. Chạy thử cục bộ với 2 máy chấm, rồi chạy thử trên testnet.
