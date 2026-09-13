# Hồ sơ yêu cầu cho `scans` và `scan_pages`

Trạng thái: bộ giá trị production-ready ban đầu được phê duyệt ngày 2026-09-10.
ADR-005 ngày 2026-09-11 đã tách `scans` public lifecycle và crawler execution
thành hai data ownership boundary, vì vậy quyền chuyển trực tiếp sang schema vật
lý đang tạm dừng. Phải bổ sung workload/consistency xuyên service và review lại
alternatives trước khi tạo Flyway migration, crawler migration hoặc entity.

Đầu vào toàn hệ thống: [hồ sơ workload V1/V1.5](WORKLOAD_PROFILE_V1_V1_5.md).

## 1. Yêu cầu nghiệp vụ — đã xác nhận

- User tạo một bounded scan cho website thuộc quyền sở hữu.
- Scan persist ở trạng thái `QUEUED` trước khi xử lý bất đồng bộ.
- Crawler xử lý số page hữu hạn, ghi thành công hoặc lỗi đã phân loại cho từng page.
- User xem tiến độ, hủy scan và xem report kể cả khi partial/failed/cancelled.
- Website đích, redirect và mọi outbound connection phải được kiểm tra an toàn.
- Restart hoặc retry không được làm mất job, double-count hoặc đảo ngược terminal state.
- Control Plane commit scan request trước khi dispatch; Crawler nhận command và
  phát progress/result theo delivery at-least-once.

Business invariant:

- State của scan chỉ chuyển theo lifecycle hợp lệ; terminal không quay lại running.
- Tiến độ không vượt giới hạn scan.
- Một kết quả page logic chỉ đóng góp vào tiến độ một lần.
- Không user nào đọc hoặc điều khiển scan/page của owner khác.
- Partial result không được trình bày như complete result.
- Cancellation và kết quả đến muộn phải có kết quả xác định, có thể kiểm thử.
- Public scan state ở Control Plane là projection có version; Crawler execution
  là nguồn sự thật của page work và terminal crawl result. Projection không được
  tự suy đoán terminal state chỉ vì request nội bộ timeout.

## 1.1 Quyền sở hữu sau ADR-005

- Control Plane sở hữu website authorization, public `scans`, idempotency/quota,
  dispatch outbox và progress/terminal projection.
- Crawler Service sở hữu crawl execution, durable `scan_pages`, page metrics,
  findings và event outbox/inbox.
- Quan hệ giữa public scan và crawler execution dùng opaque `scan_id` qua contract,
  không dùng cross-service FK, join hoặc transaction.
- Tên bảng ở đây vẫn là tên logic. Physical schema và migration ownership phải
  được duyệt lại theo từng service.

Nguồn: SCAN-001, SCAN-002, SCAN-003 và REPORT-001 trong REQUIREMENTS.md.

## 2. Workload dự kiến — một phần đã xác nhận

Đã duyệt:

- 100.000 tài khoản, 10.000 DAU, 1.000 client đồng thời.
- API: 300 request/giây duy trì; burst 1.000 request/giây trong 5 phút.
- 200 page result commit/giây.
- 100–300 crawl worker hữu dụng trong benchmark chuẩn; runtime cho phép tối đa
  10.000 active page-fetch slot để kiểm tra tải cực đại.
- Cấu hình production hiện tại snapshot tối đa 100.000 page mỗi scan, depth 4,
  24 giờ và 10.000 concurrency. Đây là capacity envelope, chưa phải bằng chứng
  phần cứng triển khai đã xử lý thành công tải đó.

Còn thiếu trước khi tính cardinality/capacity:

- Scan trung bình và tối đa mỗi user mỗi ngày.
- Page trung bình và p95 mỗi scan; tỷ lệ scan đạt giới hạn tối đa.
- Số scan đồng thời toàn hệ thống và trên cùng một website.
- Mức lệch tenant: owner lớn nhất chiếm bao nhiêu phần trăm traffic.
- Thời lượng burst của page completion và phân bố giờ cao điểm.
- Per-host crawl concurrency/rate limit và robots policy.

## 3. Mẫu truy vấn — trách nhiệm đã xác nhận, tần suất còn thiếu

| Truy vấn logic | Người dùng/hệ thống | Kết quả và mục tiêu |
| --- | --- | --- |
| Tạo scan cho website thuộc owner | API | Persist nhanh, p95 dưới 300 ms; không chờ crawler |
| Lấy scan theo id và owner | API | State, progress, cấu hình và lỗi; p95 dưới 200 ms cho progress |
| Liệt kê scan của website/owner | API | Mới nhất trước, phân trang ổn định; SLO chưa tách riêng |
| Liệt kê page outcome của scan | API report | Có filter/status và phân trang; report p95 dưới 500 ms |
| Lấy chi tiết một scan page | API report/capture | Phải kiểm tra owner qua quan hệ scan; p95 dưới 500 ms |
| Tìm scan/page đang chờ xử lý | Worker | Claim cạnh tranh, không hai owner hợp lệ đồng thời |
| Tìm công việc hết lease | Recovery | Cho phép tiếp quản an toàn, không nhận kết quả stale |
| Tìm dữ liệu đến hạn retention | Maintenance | Chạy theo batch, không chặn API |
| Dispatch scan chưa được giao | Control Plane dispatcher | Retry idempotent, quan sát dispatch age |
| Consume progress/terminal event | Control Plane inbox | Dedup, từ chối version cũ, projection không quay ngược |
| Reconcile projection | Control Plane ↔ Crawler API | Sửa missing event mà không sửa crawler evidence |

Còn thiếu:

- Frontend polling progress bao nhiêu giây một lần; có SSE hay không.
- Filter/sort chính của scan history và page report.
- Kích thước page mặc định/tối đa và chiến lược cursor pagination.
- Admin/support query thực sự cần thiết.
- Page report được proxy đồng bộ qua Crawler hay có read projection trong Control
  Plane; cần SLO và degraded behavior cho lựa chọn này.

## 4. Mẫu ghi — đã xác nhận ở mức contract

- API tạo public scan và dispatch outbox bền vững, idempotent trong một local
  Control Plane transaction.
- Crawler nhận command qua inbox/dedup và tạo một logical execution.
- Worker phát hiện page, claim page, hoàn tất hoặc ghi lỗi theo đơn vị page.
- Nhiều worker có thể xử lý các page khác nhau của cùng một scan.
- Worker chạy at-least-once; duplicate và out-of-order result là tình huống bình thường.
- Network fetch diễn ra ngoài database transaction.
- Commit kết quả page là Crawler-local transaction ngắn và phải kiểm tra
  ownership/attempt còn hiệu lực; cùng transaction tạo outbox event tương ứng.
- Tiến độ đọc nhanh có thể cần projection/counter, nhưng nguồn sự thật và cách
  reconcile chưa được chốt.

Còn thiếu:

- Batch size và flush interval cho discovery/completion.
- Một page có bao nhiêu attempt được giữ lại; retry ghi đè hay lưu lịch sử.
- Khi canonical URL thay đổi sau redirect, logical identity của page là gì.
- Kết quả sau cancellation bị bỏ hoàn toàn hay lưu làm evidence nhưng không tính progress.
- Sequence/version và reconciliation contract giữa crawler terminal state với
  Control Plane projection.
- Retention/dedup cho outbox/inbox và hành vi khi event poison liên tục thất bại.

## 5. Khối lượng dữ liệu — chưa đủ để tính

Công thức bắt buộc:

```text
scan_pages/ngày = scans/ngày × page trung bình/scan
page completion đỉnh = worker hữu dụng × completion rate/worker
storage kỳ giữ = rows/ngày × byte trung bình/row × số ngày giữ
```

Đã có throughput mục tiêu 200 page result/giây nhưng chưa có scan/ngày, page/scan,
byte/row và retention. Vì vậy chưa được quyết định partition, loại ID hoặc số index.

## 6. Nhất quán và đồng thời — nguyên tắc đã duyệt

- At-least-once execution kết hợp idempotent persistence và fencing.
- Claim và commit là transaction ngắn; không giữ lock lúc fetch mạng.
- Worker cũ/hết lease không được ghi đè attempt mới.
- Page completion không được double-count khi retry.
- Scan state monotonic; completion và cancellation race phải có một kết quả xác định.
- Background worker không dùng hết connection dành cho API.
- Không dựa riêng vào JPA `@Version` cho hot counter có 100–300 worker cạnh tranh.
- Không dựa vào exactly-once network delivery; command/event duplicate là bình thường.
- Không có distributed transaction hoặc cross-service FK để bảo vệ invariant.

Quyết định còn mở:

- Progress phải nhất quán tức thời hay được phép trễ; nếu trễ thì tối đa bao lâu.
- Counter trong `scans` là authoritative hay projection có thể reconcile.
- Khi nào scan được terminal nếu còn lease/attempt đến muộn.
- Có cho phép hai scan đồng thời trên cùng website hay phải coalesce/reject.
- Recovery time mục tiêu sau khi worker/application restart.
- Public cancellation được coi là hoàn tất ở thời điểm Control Plane nhận request
  hay chỉ sau khi Crawler xác nhận; UI và late-result rule phải thống nhất.
- Crawler terminal event bị chậm bao lâu thì Control Plane chạy reconciliation.

## 7. Retention — chưa được phê duyệt

Cần quyết định riêng:

- Giữ `scans` bao lâu.
- Giữ `scan_pages` thành công và thất bại bao lâu.
- Archive website có ảnh hưởng đến lịch sử scan không.
- User xóa tài khoản/website thì lịch sử được xóa, ẩn danh hay giữ theo thời hạn.
- Deletion SLA, export, backup retention, RPO và RTO.
- V2 comparison có cần giữ page outcome cũ hay chỉ metric/finding tổng hợp.

Không được sang bước 8 cho đến khi các câu hỏi còn mở ảnh hưởng cardinality,
concurrency và retention được trả lời hoặc được ghi nhận thành giả định đã duyệt.

## Bộ giá trị production-ready đã được phê duyệt

Các giá trị dưới đây dựa trên workload toàn hệ thống và đã được người dùng xác
nhận để làm đầu vào thiết kế. Đây vẫn là giả thuyết capacity cần được thay bằng
số liệu production sau khi phát hành.

| Chủ đề | Giá trị đề xuất | Lý do |
| --- | --- | --- |
| Scan mỗi active user/ngày | Trung bình 2, p95 10, safety limit 50 | Tạo tải đáng kể nhưng vẫn giới hạn abuse/noisy tenant |
| Page mỗi scan | Trung bình 30, p95 80, tối đa cấu hình 100.000 | Giữ workload thị trường dự kiến nhỏ nhưng cho phép một scan cực lớn có giới hạn hữu hạn |
| Tổng khối lượng | Khoảng 20.000 scan/ngày và 600.000 scan page/ngày ở mức trung bình | Suy ra từ 10.000 DAU × 2 scan × 30 page |
| Scan đang chạy mỗi user | Tối đa 3 | Bảo vệ fairness giữa owner |
| Scan đồng thời cùng website | Một scan active | Tránh tự cạnh tranh và gây tải quá mức lên website đích |
| Request tạo scan trùng | Cùng idempotency key trả scan cũ; key khác khi website đã có scan active trả conflict | Hành vi xác định, không âm thầm tạo duplicate |
| Owner lớn nhất | Tối đa 5% tải trong benchmark chuẩn; kiểm tra noisy tenant ở 20% | Buộc kiểm tra tenant skew |
| Crawler trên cùng hostname | Tối đa 2 request đồng thời, trung bình 2 request/giây và có jitter | Tôn trọng website đích dù worker toàn hệ thống cao |
| Robots policy | Tôn trọng `robots.txt` trong V1, chưa có override | Phù hợp nguyên tắc crawler an toàn và tôn trọng target |
| Polling progress | 5 giây, jitter ±20%; giảm còn mỗi 10–30 giây khi tab nền hoặc scan dài | 1.000 client không tạo polling đồng pha hoặc chiếm toàn API budget |
| Độ trễ projection progress | Tối đa 2 giây; độ trễ người dùng thấy tối đa khoảng 7 giây với polling thường | Cho phép giảm tranh chấp hot row nhưng vẫn có UX rõ ràng |
| Phân trang | Cursor; mặc định 50, tối đa 100 bản ghi | Giữ latency ổn định khi lịch sử lớn |
| Retry page | Tối đa 3 attempt logic cho lỗi transient | Tránh retry storm; lịch sử attempt vật lý vẫn cần quyết định |
| Worker chết | Phát hiện lease/heartbeat mất trong 30 giây; phân công lại p95 trong 60 giây, tối đa 120 giây | Đặt mục tiêu recovery có thể load/failure test |
| Completion cạnh tranh cancellation | Transaction commit trước quyết định kết quả: completion chỉ được tính nếu scan còn nhận kết quả tại thời điểm commit; sau khi cancellation commit, late result bị từ chối và không tăng progress | Cho race condition một kết quả xác định và kiểm thử được |
| Retention `scans` | 365 ngày | Giữ scan history một năm |
| Retention `scan_pages` | 180 ngày cho chi tiết; sau đó scan chỉ còn summary đến ngày 365 | Giới hạn bảng lớn trong khi vẫn giữ lịch sử tổng quan |
| Xóa dữ liệu active | Hoàn tất trong 7 ngày sau yêu cầu hợp lệ | Cho phép dọn theo batch, không khóa bảng lớn |
| Backup/PITR đề xuất | RPO tối đa 5 phút, RTO tối đa 30 phút; PITR 7 ngày, daily backup 30 ngày; restore drill hằng tháng | Mục tiêu production cho PostgreSQL tự vận hành, vẫn cần kiểm chứng theo kích thước dữ liệu |

## Các quyết định bổ sung để đi vào bản schema review

- Logical identity của page trong một scan là URL request đã được chuẩn hóa trước
  khi fetch. `final_url` sau redirect là evidence, không âm thầm hợp nhất hai page
  logic đã được tạo trước đó.
- V1 chỉ giữ `attempt_count`, lỗi cuối cùng và fencing generation trên
  `scan_pages`; không thêm bảng lịch sử attempt vật lý. Chi tiết retry nằm trong
  structured logs. Nếu audit từng attempt trở thành requirement, phải mở một
  thiết kế RED riêng thay vì làm phình bảng nóng ngay từ đầu.
- Chi tiết `scan_pages` được giữ 180 ngày. Từ ngày 181 đến 365 chỉ giữ scan summary,
  đúng với giá trị retention đã phê duyệt. UI phải ghi rõ khi page detail đã hết
  thời hạn lưu giữ.
