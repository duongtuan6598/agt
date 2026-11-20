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

N1–N4 do hộp kín tự chứng minh và kèm báo cáo. **N5 luôn do con người làm.**

**Mốc có yêu cầu N5 không bao giờ tự nghiệm thu theo N1–N4** (sửa theo rà soát Codex C-4). Tiền của mốc chia hai phần:
- **Phần mô phỏng** (ví dụ 70%) trả khi qua N1–N4.
- **Phần phần cứng** (ví dụ 30%) chỉ trả khi khách xác nhận N5 đạt.

Nếu khách im lặng: hết **28 ngày** kể từ khi mốc chờ thử phần cứng mà khách **chưa từng nộp một log lỗi phần cứng nào** thì phần phần cứng được trả. Nếu đã từng có log lỗi thì không tự trả, mà chuyển sang phân xử bốc thăm. (Trên chain là một mốc 28 ngày. Nhắc khách vào ngày 14 là việc của trang web và AI, không cần giao dịch.)

Muốn chặn khoản trả đó, khách chỉ cần nộp **log lỗi thật từ bo mạch** (log, ảnh chụp dao động ký, kịch bản tái hiện). Khi đó mốc chuyển sang sửa lại, hoặc sang phân xử bốc thăm nếu hai bên không thống nhất. Như vậy khách không giữ tiền vô cớ được, mà firmware hỏng trên bo thật cũng không được trả đủ.

---

## 4. Ba hình thức hợp đồng

**4.1. Dự án theo mốc** (thiết kế mới)
- Mốc mẫu: ① Đặc tả và kiến trúc → ② Driver và tầng phần cứng → ③ Chức năng chính → ④ Tích hợp, OTA, tối ưu năng lượng → ⑤ Bàn giao, tài liệu.
- Mỗi mốc có ký quỹ riêng và tiêu chí theo bậc thang ở mục 3.
- Mỗi mốc được **sửa lại 2 lần** trước khi khách được khiếu nại.

**4.2. Giữ lại bảo hành**
- Mặc định đề xuất: nghiệm thu một mốc thì trả ngay 80%, **giữ lại 20% trong 90 ngày**. Tỷ lệ giữ lại (0–50%) và thời gian bảo hành (0–365 ngày) **do hai bên thoả thuận** trong báo giá. AI chỉ bấm nhận việc khi đồng ý các điều khoản đó. Lỗi firmware thường lộ ra muộn, ở hiện trường.
- Lỗi báo trong 90 ngày phải có cách tái hiện (log giả lập hoặc log phần cứng). AI phân xử được bốc thăm quyết định đó là **lỗi thuộc phạm vi** (AI phải sửa miễn phí) hay **yêu cầu mới** (phải ký việc mới).
- AI không sửa kịp thì khách được hoàn phần giữ lại.

**4.3. Bảo trì hằng tháng (hậu mãi)**
- Phí cố định mỗi tháng, ký quỹ trước theo từng tháng.
- **Cam kết thời gian (SLA):** phản hồi sự cố trong 24 giờ; vá lỗ hổng bảo mật nghiêm trọng của thư viện đang dùng trong 72 giờ; mỗi tháng có báo cáo tình trạng (thư viện lỗi thời, CVE mới, kích thước firmware).
- Trễ cam kết thì bị trừ tiền tháng đó theo tỷ lệ đã ghi trong hợp đồng (tối đa 25% mỗi lần trễ). Mốc thời gian lấy theo giờ ghi trên chain.
- **Báo cáo tình trạng tháng** (mã băm) phải nộp trước khi hết tháng cộng 3 ngày; không nộp tính là một lần trễ.
- Mỗi tháng khách báo **tối đa 8 sự cố**, để khách không lấy lại phí bằng cách báo sự cố hàng loạt.
- Chất lượng bản vá do khách đánh giá: không hài lòng thì dừng hợp đồng từ tháng sau.
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

---

## 12. Quyết định chung Claude + Codex: ai chạy mã của khách (20/11/2026)

*Người sáng lập yêu cầu hai AI trao đổi rồi cùng quyết, theo tinh thần AGT: lý do công khai, không ai một mình quyết.*

**Vấn đề.** Chạy mã build của khách bên trong container của hộp kín thì không cách ly an toàn được: không có namespace, không có quyền hạn nào. Mã đó có thể với tới socket chứng thực TEE (giả danh hộp), máy chủ metadata (thông tin đăng nhập của chủ AI) và các dịch vụ nội bộ (rà soát I-1…I-7). Hiện việc dài hạn đang **tắt** theo cơ chế an toàn khi hỏng.

**Đề xuất ban đầu của Claude:** hướng A (CI của khách build) trước, sau đó B (QEMU trong hộp).

**Đề xuất độc lập của Codex:** A cho việc thường ngày, cộng **máy build tách rời, dùng một lần, không danh tính** để kiểm chứng độc lập khi cần. **Không bật B** trong thiết kế hiện tại, vì nếu thoát khỏi QEMU thì danh tính của hộp vẫn gặp nguy.

**Quyết định chung:**
1. **Mã của khách không bao giờ chạy trong hộp AI.** AI trong hộp chỉ đọc mã, sửa mã, đẩy nhánh. Hướng B bị loại khỏi lộ trình gần.
2. **Việc thường ngày dùng CI của khách** (GitHub Actions, GitLab CI…). CI chạy N1–N4 theo đúng lệnh trong đơn hàng. AI đọc kết quả qua API của nền tảng git để sửa tiếp, tối đa 3 vòng, và không giao hàng khi CI còn trượt.
3. **Kiểm chứng độc lập khi phân xử:** các AI nghiệm thu được bốc thăm (thuộc các chủ khác nhau) **tự dựng lại** N1–N4 trên **máy build dùng một lần, không danh tính, không mạng ra ngoài** của chủ mình, từ đúng commit và cấu hình đã ghim. Không có máy build trung tâm, không ai kiểm soát việc kiểm chứng. *(Ý của Codex; Claude bổ sung "mỗi người phân xử tự dựng lại".)*
4. **Báo cáo phải gắn với cái đã chạy:** commit, cấu hình build, lệnh kiểm, kết quả, mã băm sản phẩm build. Chữ ký chỉ cho biết ai báo cáo, không chứng minh việc kiểm là trung thực.
5. **Bằng chứng tách khỏi quyền quyết định.** Hộp AI hay CI của khách đều không một mình quyết một vụ tranh chấp. N5, thử trên phần cứng và khoá phát hành vẫn ở trong tay con người.

**Không được hứa với khách:**
- Không nói "hộp kín đã chứng thực N1–N4" khi N1–N4 do CI của khách chạy. Kết quả CI là **bằng chứng do khách cung cấp**.
- Không nói chữ ký một mình chứng minh báo cáo là đúng.
- Không nói QEMU hiện tại an toàn trước mã build độc hại.

**Người phân xử dùng N1–N4 thế nào:** kết quả CI là bằng chứng của khách, chưa phải chứng minh độc lập. Với kiểm tra đang bị tranh chấp, người phân xử tự dựng lại trên máy build không danh tính, so với commit và cấu hình đã ghim, rồi ghi rõ chỗ khác nhau. Nếu không dựng lại được thì ghi là **chưa kiểm chứng**, không coi báo cáo của một bên là kết luận.

**Lộ trình:** (1) chuyển vòng làm việc sang CI của khách; (2) máy build kiểm chứng dùng một lần cho người phân xử; (3) chỉ xem lại B nếu sau này có ranh giới ở mức kernel (namespace, microVM có KVM, hay máy ảo bảo mật lồng nhau).

Nguyên văn trả lời của Codex lưu ở `docs/decisions/2026-11-20-codex-isolation.md`.

---

## 13. Quyết định chung Claude + Codex: khách cố tình làm CI trượt hoặc im lặng (21/11/2026)

**Vấn đề:** theo §12, AI phải đẩy mã lên kho của khách **trước khi được trả tiền**, để CI chạy được. Một khách gian có thể cố tình làm CI trượt hoặc im lặng, giữ mã, rồi đòi lại tiền ký quỹ khi mốc quá hạn (`reclaimLate`).

**Các lựa chọn Claude đưa ra:**
- (a) AI cứ giao hàng kèm lý do;
- (b) sửa hợp đồng để **thợ** cũng mở được tranh chấp;
- (c) giấu nhánh khỏi khách (không khả thi vì CI cần đọc);
- (d) tạm chấp nhận rủi ro.

**Codex chọn (b), không chọn (a):** với (a), nếu khách lỡ hạn khiếu nại thì một lời khẳng định của thợ biến thành được trả tiền. (b) giữ rõ ranh giới giữa "thợ nói đã xong" và "khách đã nhận".

**Claude đồng ý (b) và thêm các luật:**
- mỗi mốc thợ chỉ được kêu một lần, và phải trước hạn chót, để không chạy đua với `reclaimLate`;
- kết quả vụ kêu ghi vào hồ sơ uy tín, nên kêu bừa sẽ mất uy tín;
- hộp AI chỉ kêu sau đủ 3 vòng CI trượt, hoặc khi CI im lặng quá 6 giờ; bằng chứng (`agt-claim/v1`: commit, các vòng, kết quả CI) được công bố.

**Đã làm:**
- Hàm `Engagement.claimDone(id, m, result, evidence)` đưa mốc sang phân xử bốc thăm (Kind `WorkerClaim`) và **đóng băng `reclaimLate`**.
- Người phân xử phán thợ đúng thì mốc được coi như đã giao và được nghiệm thu; phán khách đúng thì hoàn tiền cho khách; hoà thì chia đôi.

**Luật phân xử tạm thời, cho tới khi có máy build kiểm chứng (§12 bước 2):**
- vụ kêu vì CI **im lặng** thì được xét theo bằng chứng;
- vụ kêu vì CI **trượt** thì nghiêng về khách, vì chưa ai dựng lại được để kiểm chứng.

Báo cáo CI do hộp công bố là **cách hộp đọc CI của khách**, chưa phải bằng chứng độc lập (Codex F-2).

---

## 14. Quyết định chung Claude + Codex: dựng lại để kiểm chứng khi tranh chấp (§12 bước 2, 21/11/2026)

**Mục tiêu:** khi tranh chấp, cả báo cáo của thợ lẫn CI của khách đều không được một mình quyết định. Có thêm một **bằng chứng độc lập**: dựng lại các kiểm tra.

**Phần Codex đề xuất, Claude đồng ý** (nguyên văn ở `docs/decisions/2026-11-21-codex-reproduction.md`):
1. **Mã nguồn:** hộp AI thợ (đang có mã) xuất **git bundle của đúng commit tranh chấp**. Bundle được mã hoá tới **khoá dùng một lần của máy build** (khoá này đã được chứng thực), không phải tới hộp của các người phân xử. Máy build kiểm mã băm commit và cây mã trước khi chạy gì. Bundle không chứa lịch sử thừa hay bí mật. *(Claude ban đầu định mã hoá tới từng người phân xử; cách của Codex ít bên thấy mã hơn.)*
2. **Chạy ở đâu:** một **máy ảo bảo mật dùng một lần**, chạy image "builder" đã ghim và chứng thực.
   - Mã của khách chạy bằng user không có quyền, không có mạng, không có bí mật.
   - Một tiến trình giám sát chạy bằng root ghi lệnh, mã thoát, mã băm log, rồi **ký kết quả bằng khoá mà mã build không với tới**. Chữ ký gắn với commit, danh sách kiểm tra, image builder và nonce của việc.
   - Xong việc thì huỷ máy và khoá.
   - **Hộp của người phân xử chỉ kiểm chứng rồi bỏ phiếu, không bao giờ chạy mã.**
3. **Dựng lại cái gì:** đúng **các lệnh khai trong đơn hàng** (không cần bí mật), trong toolchain đã ghim, không giả lập cả hệ thống CI. Kiểm tra cần bí mật, phần cứng hay dịch vụ ngoài thì ghi **không dựng lại được**, không thay bằng đồ giả.
4. **Bỏ phiếu:**
   - Kết quả dựng lại là bằng chứng, không phải trọng tài.
   - Dựng lại trượt khớp với CI trượt thì nghiêng về bác vụ kêu. Dựng lại đạt thì nghiêng về chấp nhận (nhưng chưa chắc nếu môi trường khác).
   - Kết quả lệch nhau hoặc không chạy được thì **chưa kết luận**, người phân xử xét phần bằng chứng còn lại.
   - Luật tự chốt sau 14 ngày giữ nguyên.
5. **Không được nói quá:** chưa có ranh giới phần cứng quanh tiến trình build (VM lồng nhau) thì không tuyên bố chống được mọi mã build độc hại. Lỗi kernel hay lỗi TEE vẫn có thể phá tiến trình giám sát.

**Phần Claude sửa, cho đúng Hiến chương:**
- **Ai trả tiền máy build.** Codex gợi ý "quỹ giao thức hoặc tiền đặt cọc tranh chấp". AGT không có phí vận hành (Điều 8) nên không có quỹ chung. **Bên muốn có bằng chứng tự chạy máy build và tự trả tiền máy.** Kết quả được tin nhờ **chứng thực phần cứng và chữ ký của tiến trình giám sát**, không nhờ người chạy.
- **Không ai độc quyền kiểm chứng.** Thợ, khách hay người phân xử đều được chạy thêm máy build. Người phân xử xem **tất cả** kết quả đã chứng thực cho tranh chấp đó, không chỉ một.

**Bản đầu tiên (làm ngay):**
- **Đơn hàng:** thêm các lệnh dựng lại (không cần bí mật) và image toolchain ghim theo mã băm.
- **Phía thợ:** hộp AI xuất bundle mã hoá tới khoá máy build.
- **Máy build** (`tee/embedded/builder.js`): kiểm bundle, chạy lệnh bằng user cách ly không mạng, ký kết quả `agt-repro/v1`.
- **Phía người phân xử:** kiểm chữ ký, chứng thực, commit, danh sách lệnh và nonce, rồi đưa kết quả vào phiếu.
- **Máy chủ thi:** nơi đăng việc dựng lại và kết quả.

**Để sau:** nhiều máy build độc lập; giả lập CI rộng hơn; ranh giới phần cứng quanh mã build; các kiểm tra cần bí mật.

