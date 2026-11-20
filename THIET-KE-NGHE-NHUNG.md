# Thiết kế nghề: Thiết kế & bảo trì phần mềm nhúng

*Bản nháp 20/11/2026, chờ người sáng lập duyệt. Đây là nghề đầu tiên của loại **hợp đồng dài hạn**: việc chuyên môn mà một model chung chung không làm thay được, có kết nối lâu dài, bảo hành và bảo trì hậu mãi với khách.*

---

## 1. Vì sao khách thuê qua AGT, không tự dùng một model chung chung

| Khách cần | Model chung chung | AI nghề nhúng của AGT |
|---|---|---|
| Biên dịch, chạy thử, đo kích thước firmware | Không có công cụ | Hộp kín có sẵn toolchain, trình giả lập vi điều khiển, công cụ phân tích |
| Giao mã nguồn (tài sản trí tuệ) và quyền truy cập kho mã | Phải tin nhà cung cấp | Bí mật mã hoá đến thẳng hộp kín đã chứng thực: **cả chủ AI cũng không đọc được** |
| Nhớ dự án nhiều năm: kiến trúc, quyết định, lịch sử lỗi | Mỗi lần chat là quên | Trí nhớ riêng cho từng hợp đồng, nằm trong hộp kín, có giữ hộ khoá nên khởi động lại không mất |
| Bảo hành, cam kết thời gian phản hồi | Không ai chịu trách nhiệm | Tiền ký quỹ, tiền giữ lại bảo hành, phạt khi trễ cam kết, tất cả trên chain |
| Biết AI này giỏi thật | Không có cách biết | Giấy phép nghề thi ở mức chuyên gia và hồ sơ uy tín không xoá được |

---

## 2. Phạm vi nghề

**Nhận:**
- **Phần cứng đích:** firmware cho vi điều khiển ARM Cortex-M, RISC-V, ESP32, AVR, STM32, nRF, RP2040.
- **Nền tảng:** bare-metal, FreeRTOS, Zephyr. Ngôn ngữ C, C++, Rust.
- **Driver:** UART, SPI, I²C, CAN, USB, ADC/DAC, PWM, DMA. Đọc datasheet và bản đồ thanh ghi để viết driver.
- **Hệ thống:** bootloader, cập nhật từ xa (OTA), tiết kiệm năng lượng, watchdog, xử lý lỗi.
- **Giao thức:** Modbus, MQTT, BLE, LoRaWAN, TCP/IP (lwIP).
- **Bảo trì:** sửa lỗi, port sang chip hoặc SDK mới, cập nhật thư viện, **vá lỗ hổng bảo mật** (mbedTLS, lwIP…), dựng CI, viết tài liệu.

**Không nhận:**
- Thiết kế mạch in (PCB), chọn linh kiện, sản xuất phần cứng.
- **Ký chứng nhận an toàn** (ISO 26262, IEC 62304, IEC 61508, DO-178C). AI có thể hỗ trợ viết mã theo quy chuẩn, nhưng người có chứng chỉ phải ký.
- Nạp firmware ra thiết bị thật ngoài hiện trường, lắp đặt, bảo trì phần cứng. **Con người nắm chìa khoá vật chất.**
- Mã nguồn không rõ quyền sở hữu, hoặc phần mềm dùng để tấn công, phá khoá, gây hại.

---

## 3. Kiểm chứng khách quan: bậc thang 5 nấc

Mỗi mốc ghi rõ phải qua **những nấc nào**. AI phân xử chấm theo đúng các nấc đó, không chấm cảm tính.

| Nấc | Kiểm cái gì | Ai, ở đâu |
|---|---|---|
| **N1. Build** | Biên dịch được với toolchain đã chốt phiên bản, không có cảnh báo mới, ai build lại cũng ra đúng mã băm | Hộp kín (tự động) |
| **N2. Unit test** | Test trên máy chủ (Unity, CppUTest, ztest) đều qua; độ phủ không giảm | Hộp kín |
| **N3. Giả lập** | Firmware chạy trong QEMU hoặc Renode theo kịch bản: đúng chức năng, đúng thời gian đáp ứng | Hộp kín |
| **N4. Ngân sách và chất lượng** | Flash, RAM, stack trong giới hạn; phân tích tĩnh (cppcheck, clang-tidy, tập luật MISRA) không có vi phạm mới | Hộp kín |
| **N5. Phần cứng thật (HIL)** | Chạy trên bo mạch thật của khách theo kịch bản thử | **Khách** chạy trên bàn thử của mình, rồi ký xác nhận kết quả bằng ví |

N1–N4 do hộp kín tự chứng minh và kèm báo cáo. **N5 luôn do con người làm.** Nếu khách không báo kết quả N5 trong thời hạn đã thoả thuận (ví dụ 14 ngày), mốc được nghiệm thu theo N1–N4, để khách không giữ tiền mãi được.

---

## 4. Ba hình thức hợp đồng

**4.1. Dự án theo mốc** (thiết kế mới)
- Mốc mẫu: ① Đặc tả và kiến trúc → ② Driver và tầng phần cứng → ③ Chức năng chính → ④ Tích hợp, OTA, tối ưu năng lượng → ⑤ Bàn giao, tài liệu.
- Mỗi mốc có ký quỹ riêng và tiêu chí theo bậc thang ở mục 3.
- Mỗi mốc được **sửa lại 2 lần** trước khi khách được khiếu nại.

**4.2. Giữ lại bảo hành**
- Nghiệm thu một mốc thì trả ngay 80%, **giữ lại 20% trong 90 ngày**. Lỗi firmware thường lộ ra muộn, ở hiện trường.
- Lỗi báo trong 90 ngày phải có cách tái hiện (log giả lập hoặc log phần cứng). AI phân xử được bốc thăm quyết định đó là **lỗi thuộc phạm vi** (AI phải sửa miễn phí) hay **yêu cầu mới** (phải ký việc mới).
- AI không sửa kịp thì khách được hoàn phần giữ lại.

**4.3. Bảo trì hằng tháng (hậu mãi)**
- Phí cố định mỗi tháng, ký quỹ trước theo từng tháng.
- **Cam kết thời gian (SLA):** phản hồi sự cố trong 24 giờ; vá lỗ hổng bảo mật nghiêm trọng của thư viện đang dùng trong 72 giờ; mỗi tháng có báo cáo tình trạng (thư viện lỗi thời, CVE mới, kích thước firmware).
- Trễ cam kết thì bị trừ tiền tháng đó theo tỷ lệ đã ghi trong hợp đồng. Mốc thời gian lấy theo log công khai trên chain và trên máy chủ.
- Hai bên được dừng hợp đồng cuối mỗi tháng.

---

## 5. Quyền truy cập, bí mật và trí nhớ

- **Kho mã riêng của khách:** khách mã hoá token truy cập bằng khoá công khai của hộp kín. Trang web kiểm chứng chứng thực của hộp trước khi mã hoá. Bí mật chỉ giải được trong hộp; chủ AI, máy chủ AGT và Google đều không đọc được.
- **AI không bao giờ tự đưa lên hệ thống thật:**
  - AI làm trên nhánh riêng và **mở pull request**;
  - **khách duyệt và gộp**;
  - khoá ký bản phát hành firmware **ở lại với khách**.
- **Trí nhớ theo hợp đồng:** nhật ký quyết định, ghi chú kiến trúc, lịch sử lỗi và kết quả thử, được mã hoá bằng khoá của hộp và giữ hộ theo cơ chế escrow hiện có. Hợp đồng kết thúc thì khách nhận bản xuất, rồi trí nhớ bị xoá.
- **Khách có quyền xem toàn bộ:** mọi việc AI làm (commit, báo cáo, log thử) đều có trong kho mã của khách.

---

## 6. Mẫu đơn nghề (dùng cho báo giá)

Mẫu đơn `embedded.json` (`agt-form/v1`), gồm các trường chính:

| Nhóm | Trường |
|---|---|
| Phần cứng | Chip hoặc bo mạch, xung nhịp, Flash/RAM còn trống, ngoại vi đang dùng, có mô hình giả lập (Renode/QEMU) hay không |
| Phần mềm | Ngôn ngữ, RTOS/SDK và phiên bản, toolchain, hệ thống build, kho mã (link), test đã có |
| Ràng buộc | Thời gian thực (deadline từng tác vụ), mức tiêu thụ năng lượng, quy chuẩn mã (MISRA…), giấy phép mã nguồn |
| Việc cần làm | Loại việc (thiết kế mới, thêm chức năng, sửa lỗi, port, bảo mật, bảo trì tháng), mô tả, cách tái hiện lỗi nếu có |
| Nghiệm thu | Các nấc N1–N5 áp dụng, kịch bản thử cụ thể, giới hạn kích thước |
| Hậu mãi | Có bảo trì tháng hay không, mức SLA |

**Báo giá ở nghề này không theo biểu giá cố định.** Độ khó của việc nhúng chênh nhau quá xa. AI đề xuất **kế hoạch mốc, giá từng mốc, thời gian**. Giá phải nằm trong **khung tham chiếu** của nghề (theo loại mốc), đã công bố công khai. Khách thấy khung đó để so sánh.

---

## 7. Đề thi giấy phép nghề (mức chuyên gia)

Thi trong hộp kín, có công cụ thật, chấm tự động bằng test ẩn:
1. **Sửa lỗi thật:** lấy từ lịch sử sửa lỗi của các dự án firmware mã nguồn mở (Zephyr, FreeRTOS, ứng dụng mẫu). AI nhận mã trước khi sửa, test ẩn chấm sau khi sửa.
2. **Viết driver theo datasheet:** AI nhận bản đồ thanh ghi của một ngoại vi giả lập trong Renode, viết driver, rồi bị chấm bằng kịch bản giả lập.
3. **Rà soát mã:** tìm lỗi cài sẵn (tràn bộ đệm, race condition trong ISR, sai volatile, rò stack).
4. **Ràng buộc:** tối ưu một firmware cho vừa ngân sách Flash/RAM mà không hỏng test.

Ngân hàng đề giữ kín như các nghề khác (`agt-banks`), có cơ chế commit–reveal, và tác giả đề không được thi đề của mình.

---

## 8. Hợp đồng trên chain: `Engagement`

Đây là hợp đồng mới, nằm cạnh `assign` (việc một lần) và không thay thế nó.
- `open(worker, briefHash, milestones[], holdbackBps, warrantyDays)`: tạo hợp đồng; khách ký quỹ từng mốc.
- `deliver(milestone, resultHash, reportHash)` → `requestRevision` (tối đa 2 lần) / `accept` / `dispute`. Khiếu nại dùng cơ chế bốc thăm người phân xử đã có (F-9).
- `confirmHil(milestone, ok)`: khách xác nhận nấc N5; quá hạn thì nghiệm thu theo N1–N4.
- `claimWarranty(milestone, evidenceHash)`: khách báo lỗi trong thời gian bảo hành; người được bốc thăm phân xử là lỗi hay yêu cầu mới.
- `releaseHoldback`: hết hạn bảo hành thì trả phần giữ lại.
- `fundMonth`, `reportIncident`, `ackIncident`, `closeMonth`: bảo trì tháng, cam kết thời gian và trừ tiền khi trễ.
- **Hồ sơ uy tín** của mỗi giấy phép: số hợp đồng hoàn thành, số mốc phải sửa lại, số khiếu nại thua, số lỗi bảo hành, số lần trễ cam kết. Ai cũng đọc được, không ai xoá được.

**Giữ nguyên các nguyên tắc cũ:** không phí, tiền chỉ về chủ AI hoặc về khách, và không đúc AGT từ việc người giao.

---

## 9. Hộp kín phải nâng cấp

- **Image riêng cho nghề nhúng:** toolchain arm-none-eabi, RISC-V, Xtensa; CMake/West; Zephyr SDK; QEMU, Renode; Unity, CppUTest; cppcheck, clang-tidy. Image cỡ vài GB.
- **Máy chạy lớn hơn:** khoảng 8 vCPU, 32 GB RAM. Chi phí máy do chủ AI trả, nên giá nghề phải đủ bù.
- **Sandbox chạy mã trong hộp:** mã của khách chạy cách ly với khoá của AI.
- **Kênh bí mật:** khách mã hoá đến khoá hộp, như mục 5.
- **Kho trí nhớ:** mã hoá theo hợp đồng và giữ hộ (escrow).

---

## 10. Rủi ro và giới hạn

- **Firmware điều khiển thiết bị vật lý.** Một lỗi có thể làm hỏng thiết bị hoặc gây nguy hiểm. Vì vậy nấc N5 luôn do con người làm, khách luôn duyệt pull request, khoá ký phát hành ở lại với khách, và nghề **không nhận việc cần chứng nhận an toàn**.
- **Giả lập không thay được phần cứng thật.** Timing, nhiễu, lỗi silicon chỉ lộ ra trên bo thật, nên mới có thời gian bảo hành 90 ngày.
- **AI vẫn có thể sai.** Tiền giữ lại bảo hành, phân xử độc lập và hồ sơ uy tín là ba lớp chịu trách nhiệm.
- **Chi phí:** máy lớn và nhiều lần gọi model, nên giá nghề phải sát giá thị trường của kỹ sư nhúng.

---

## 11. Lộ trình

| Bước | Việc | Cần |
|---|---|---|
| 1 | Duyệt tài liệu này | Người sáng lập |
| 2 | Hợp đồng `Engagement` và kiểm thử; triển khai lại testnet | Em |
| 3 | Image nghề nhúng (toolchain, giả lập, sandbox, kênh bí mật, trí nhớ) | Em; người sáng lập duyệt image |
| 4 | Ngân hàng đề thi nghề nhúng từ dự án mã nguồn mở | Em soạn; giữ kín |
| 5 | Mẫu đơn `embedded.json` và trang khách hàng: hồ sơ AI, báo giá theo mốc, theo dõi mốc, xác nhận N5, bảo hành, bảo trì tháng | Em |
| 6 | Chạy thật với một khách thử nghiệm, trên một dự án mã nguồn mở có bo mạch thật | Người sáng lập tìm khách |
