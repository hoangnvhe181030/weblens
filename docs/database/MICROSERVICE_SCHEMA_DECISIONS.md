# Bộ quyết định trước schema V1/V1.5 theo microservice

Trạng thái: **ĐƯỢC THAY THẾ MỘT PHẦN BỞI ADR-006**.  
Ngày lập: 2026-09-11.

Tài liệu này hoàn tất đầu vào và đưa ra phương án khuyến nghị trước khi viết lại
schema vật lý. Đây không phải DDL, migration hoặc phê duyệt để tạo entity. Nó áp
dụng cổng RED sau khi ADR-005 thay đổi data ownership.

Sau quyết định tích hợp ClickHouse, D1, D5, D9, D10 và D11 trong tài liệu này
không còn là baseline đầy đủ. Hãy review
[bộ quyết định hybrid PostgreSQL/ClickHouse](HYBRID_POSTGRES_CLICKHOUSE_DECISIONS.md)
trước khi thiết kế schema vật lý. Các quyết định còn lại chỉ tiếp tục áp dụng khi
không mâu thuẫn với ADR-006.

## 1. Phạm vi và dữ liệu đầu vào đã có

Các giá trị đã được phê duyệt và tiếp tục được sử dụng:

- 100.000 tài khoản, 10.000 DAU và 1.000 client đồng thời.
- Khoảng 20.000 scan/ngày, trung bình 30 page, p95 80 và tối đa 100 page/scan.
- Khoảng 600.000 page/ngày; đỉnh 200 page result commit/giây.
- 100–300 crawl worker; tối đa hai request đồng thời và trung bình 2 request/giây
  trên cùng hostname.
- Tối đa ba scan active/user và một scan active/website.
- Progress projection trễ tối đa hai giây; UI polling năm giây có jitter.
- Scan summary giữ 365 ngày; page detail giữ 180 ngày.
- Worker chết được phát hiện trong 30 giây, phân công lại p95 60 giây và tối đa
  120 giây.
- Capture Worker đồng thời 10; traffic duy trì 0,2 capture/giây và burst 2/giây.
- PostgreSQL 17.x tự triển khai; binary lớn nằm trong S3/MinIO.

Các con số trên là workload giả thuyết để benchmark, không phải capacity đã được
đo trong production.

## 2. Phân loại và quyền sở hữu bảng

### 2.1 Control Plane database

| Bảng logic | Mức | Vai trò |
| --- | --- | --- |
| `users` | GREEN | Identity và trạng thái tài khoản; giữ schema hiện hữu |
| `auth_sessions` | GREEN | Refresh/session rotation; giữ schema hiện hữu |
| `websites` | RED hiện hữu | Target thuộc owner; chỉ forward migration sau phê duyệt |
| `scans` | RED hiện hữu | Public request, config snapshot và progress/terminal projection |
| `capture_requests` | RED mới | Public capture request/projection; không phải browser execution queue |
| `outbox_events` | RED mới | Durable dispatch/event phát ra từ local transaction |
| `inbox_messages` | RED mới | Dedup và version guard cho event nhận từ data plane |

### 2.2 Crawler database

| Bảng logic | Mức | Vai trò |
| --- | --- | --- |
| `crawl_executions` | RED mới | Nguồn sự thật execution/lifecycle của một `scan_id` |
| `scan_pages` | RED | Durable frontier, lease, retry và page outcome |
| `page_metrics` | RED | Một metric set có version cho page đã hoàn tất |
| `findings` | RED | Deterministic findings bất biến theo rule version |
| `host_leases` | RED mới | Điều phối concurrency/politeness cùng hostname giữa nhiều instance |
| `inbox_messages` | RED mới | Dedup command từ Control Plane |
| `outbox_events` | RED mới | Progress/terminal event bền vững |

`page_links` vẫn RED nhưng khuyến nghị không triển khai trong V1/V1.5 vì chưa có
use case sản phẩm cần full link graph và cardinality có thể lớn hơn nhiều page.

### 2.3 Capture database

| Bảng logic | Mức | Vai trò |
| --- | --- | --- |
| `capture_jobs` | RED | Browser execution queue, lease, retry và fencing |
| `page_snapshots` | RED | Metadata rendered snapshot |
| `network_requests` | RED | Network metadata đã redaction và giới hạn |
| `captured_resources` | RED | Liên kết eligible response body với object đã lưu |
| `capture_objects` | RED mới | Hash, storage key, trạng thái và garbage collection của object |
| `inbox_messages` | RED mới | Dedup capture command |
| `outbox_events` | RED mới | Progress/terminal capture event |

Các bảng mới được đề xuất ở mức RED vì chúng ảnh hưởng concurrency, recovery,
retention hoặc data consistency. Chúng không được mặc nhiên xem là boilerplate.

## 3. Các quyết định khuyến nghị cần phê duyệt

### D1 — Topology PostgreSQL

**Khuyến nghị:** một PostgreSQL cluster production ban đầu, ba logical database:
`weblens_control`, `weblens_crawler`, `weblens_capture`. Mỗi database có migration
owner, runtime role, connection cap và backup/restore verification riêng.

Không dùng ba schema chung một database vì direct join/FK rất dễ trở thành API
ngầm. Ba cluster vật lý riêng cho isolation tốt hơn nhưng tăng chi phí HA, PITR,
monitoring và connection management quá sớm.

### D2 — Nguồn sự thật và projection

**Khuyến nghị:** Control Plane `scans` là nguồn sự thật của user request,
authorization, quota và public projection. Crawler `crawl_executions` là nguồn sự
thật của crawl work/page outcome và terminal execution. Capture có quy tắc tương
tự giữa Control Plane `capture_requests` và Capture `capture_jobs`.

Không service nào tự suy đoán remote terminal state từ timeout. Projection chỉ
áp dụng event có sequence/version mới hơn và được reconciliation định kỳ.

### D3 — Giao nhận công việc

**Khuyến nghị:** versioned REST + transactional outbox/inbox, delivery
at-least-once. `scan_id` hoặc `capture_request_id` là logical idempotency key phía
consumer; `message_id` dedup physical delivery.

Chưa thêm Kafka/Redis. Nếu benchmark cho thấy dispatch age hoặc event throughput
không đạt, mở ADR riêng thay vì đổi transport mà giữ nguyên lỗi consistency.

### D4 — Cancellation

**Khuyến nghị:** scan chưa dispatch có thể chuyển `CANCELLED` trong Control Plane.
Scan đã dispatch chuyển `CANCEL_REQUESTED`, ghi cancellation outbox và chỉ thành
`CANCELLED` sau crawler acknowledgement/terminal event. Page result commit trước
crawler cancellation transaction được giữ; stale completion sau đó bị fencing
từ chối và không tăng progress.

API trả `202 Accepted` cho cancellation đang chờ, không báo đã hủy hoàn tất khi
Crawler chưa xác nhận.

### D5 — Report data path

**Khuyến nghị:** Control Plane authorize request rồi proxy/query Crawler API cho
page-level report. Control Plane chỉ giữ scan summary projection; không replicate
`scan_pages`, metrics hoặc findings trong V1/V1.5.

Lựa chọn này tránh dual-write và duplication hàng trăm triệu row. Khi Crawler
degraded, summary vẫn đọc được nhưng page detail trả lỗi degraded có retry hint,
không trả dữ liệu cũ mà không ghi freshness.

### D6 — Event granularity

**Khuyến nghị:** không phát một event cho mỗi page. Crawler coalesce progress tối
đa một event/giây/execution hoặc mỗi 10 page, tùy điều kiện nào đến trước; terminal
event phát ngay. Page evidence luôn commit trước event.

Với 20.000 scan/ngày và khoảng ba progress event/scan trung bình, baseline khoảng
60.000 progress event/ngày thay vì 600.000 page event/ngày; benchmark thêm trường
hợp scan đạt 100 page và nhiều scan chạy đồng thời.

### D7 — Retention outbox/inbox

**Khuyến nghị:** outbox chưa publish/ack không được purge theo tuổi. Outbox đã ack
và inbox đã xử lý giữ bảy ngày; poison/dead message metadata giữ 30 ngày. State
sequence/terminal guards phải làm duplicate rất muộn trở thành no-op kể cả sau
khi inbox dedup row đã hết hạn.

Purge chạy theo batch có commit riêng. Payload không chứa credential hoặc crawled
body và có giới hạn 64 KiB.

### D8 — Identifier

**Khuyến nghị:** giữ UUID hiện hữu cho `users`, `websites`, `scans` để tương thích.
ID mới đi qua service boundary dùng UUIDv7 do application tạo và validate; không
thêm extension cho PostgreSQL 17. Row chỉ có ý nghĩa nội bộ dùng bigint identity
hoặc natural composite key khi giúp giảm index.

UUIDv7 không được dùng để suy ra authorization hoặc thời gian nghiệp vụ chính xác.

### D9 — Partition và retention vật lý

**Khuyến nghị:** chưa partition bảng Control Plane hiện hữu trước khi benchmark
chứng minh cần. Các bảng evidence dự kiến vượt hàng chục triệu row gồm
`scan_pages`, `page_metrics`, `findings`, `network_requests` và
`captured_resources` dùng monthly range partition theo immutable retention bucket
được gán từ thời điểm execution/capture bắt đầu.

Mọi PK/unique/FK nội bộ của bảng partitioned phải chứa partition key. API query
theo aggregate ID nên truyền thêm retention bucket; query không có bucket chỉ
được phép quét số partition đang retention có giới hạn. Chưa dùng subpartition
hash trước benchmark.

### D10 — Metrics và findings

**Khuyến nghị:** `page_metrics` là wide typed row cho bộ metric V1 ổn định, không
dùng EAV. JSONB chỉ chứa evidence mở rộng có schema version và giới hạn 16 KiB;
không tạo GIN khi chưa có containment query. `findings` là row bất biến theo
page/rule/rule-version và có cap 50 finding/page để bảo vệ dữ liệu lỗi.

Baseline benchmark dùng trung bình một metric row/page và hai finding/page:
khoảng 108 triệu metric row và 216 triệu finding row trong 180 ngày.

### D11 — Page retry và fencing

**Khuyến nghị:** V1 giữ `attempt_count`, lỗi cuối cùng, `lease_owner`,
`lease_expires_at` và `lease_generation` trên `scan_pages`; không tạo bảng attempt
history. Claim bằng `FOR UPDATE SKIP LOCKED`; complete là conditional update theo
execution/page/status/owner/generation. Metric/finding và terminal page update
commit trong cùng Crawler-local transaction.

### D12 — Host coordination

**Khuyến nghị:** thêm `host_leases` theo canonical hostname để enforce tối đa hai
slot và `next_allowed_at` giữa nhiều Crawler instance. Không khóa row host trong
suốt network fetch: transaction chỉ cấp slot/lease rồi commit; worker heartbeat
và release bằng fencing. Lease hết hạn cho phép recovery.

Hot-host benchmark phải có một hostname nhận ít nhất 20% page traffic. Nếu một
row/hostname trở thành bottleneck, xem xét bucketed slots hoặc deterministic host
sharding trong một revision riêng, không bỏ politeness limit.

### D13 — Capture bounds

**Khuyến nghị:** tối đa 500 network metadata row, 100 captured resource body và
50 MiB tổng object/capture; tối đa 10 MiB/resource. Screenshot và rendered HTML
tính trong tổng byte. Vượt giới hạn tạo capture decision/failure đã phân loại,
không làm worker giữ thêm RAM hoặc ghi payload vào PostgreSQL.x
**Khuyến nghị:** public capture summary 365 ngày; snapshot/network/resource/object
evidence 180 ngày. Object được content-addressed và dedup chỉ trong cùng owner.
PostgreSQL không lưu presigned URL hoặc refcount cập nhật không nguyên tử.

Upload object xảy ra trước metadata transaction. Object không có reference được
inventory/GC dọn sau grace period; metadata chỉ tham chiếu object ở trạng thái
`AVAILABLE`.

### D15 — Xóa dữ liệu xuyên service

**Khuyến nghị:** Control Plane sở hữu deletion request/saga và phát command cho
Crawler/Capture. Mỗi service xóa dữ liệu của mình theo retention/batch, ghi
idempotent acknowledgement; Control Plane chỉ báo hoàn tất khi nhận đủ ack.
Deletion SLA dữ liệu active là bảy ngày. Backup có thể giữ bản đã xóa tối đa theo
policy backup 30 ngày và phải được công bố rõ.

Không dùng cascade hoặc FK xuyên database để giả lập distributed deletion.

### D16 — Tenant isolation và quyền database

**Khuyến nghị:** mọi user-facing aggregate query ở Control Plane có `owner_id`.
Crawler/Capture lưu owner snapshot để scope query/delete nhưng chỉ tin command từ
service account đã xác thực. Mỗi runtime role chỉ có DML trên database của mình;
migration role tách riêng, không service role nào là owner/superuser/BYPASSRLS.

Chưa bật RLS ở revision đầu vì PgBouncer transaction pooling và nhiều language
driver làm tenant context dễ cấu hình sai. Có thể thêm RLS sau threat-model và
integration test riêng.

## 4. Những phương án bị loại ở baseline

- Một database/schema chung và dùng FK xuyên mọi bảng.
- Crawler ghi trực tiếp `scans` của Control Plane.
- Control Plane đọc thẳng `scan_pages` hoặc capture tables.
- Exactly-once delivery qua HTTP.
- Một event cho mỗi page chỉ để cập nhật progress.
- ClickHouse làm queue hoặc nguồn lifecycle.
- Lưu HTML/screenshot/resource body trong PostgreSQL.
- Full `page_links` graph ở V1/V1.5.
- Giữ database transaction trong lúc fetch, render hoặc upload.

## 5. Điều kiện hiện hành để chuyển sang schema vật lý

Không còn phê duyệt D1–D16 nguyên trạng vì ClickHouse đã thay đổi topology, report
path và nơi lưu evidence. Điều kiện hiện hành là review H1–H10 trong
[bộ quyết định hybrid](HYBRID_POSTGRES_CLICKHOUSE_DECISIONS.md), đồng thời giữ các
quyết định D2–D4, D6–D8 và D12–D16 không mâu thuẫn với ADR-006.

Sau phê duyệt, revision schema phải trình bày riêng cho từng PostgreSQL database
và ClickHouse database: constraint/logical key, index/ordering key gắn với query,
transaction/ingestion, partition/retention, benchmark, concurrency/failure test
và forward migration từ foundation hiện hữu.
