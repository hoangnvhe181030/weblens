# Tích hợp ClickHouse làm kho dữ liệu phân tích

Trạng thái: Accepted  
Ngày: 2026-09-11  
Bổ sung và sửa đổi: ADR-005

## Bối cảnh

Người dùng quyết định tích hợp cả bản fork CrawlObserver và ClickHouse vào
WebLens V1/V1.5. Crawler tạo dữ liệu theo trang, liên kết và finding với lưu lượng
ghi lớn; Capture Worker tạo nhiều network/resource metadata. Đây là workload phân
tích theo scan, thời gian, status, rule và URL, phù hợp với columnar storage hơn
các truy vấn hàng đợi và transaction ngắn.

CrawlObserver hiện dùng ClickHouse trực tiếp cho crawl session, page và link. Tuy
nhiên schema gốc không phải schema SaaS cuối cùng của WebLens: nó chưa bảo vệ đầy
đủ tenant boundary, durable work handoff, fencing, idempotent cross-service
delivery và lifecycle xóa dữ liệu của ba service.

## Quyết định

WebLens dùng mô hình hybrid persistence:

- PostgreSQL vẫn là nguồn sự thật cho identity, authorization, website, public
  scan/capture lifecycle, durable frontier, lease, retry, fencing, inbox/outbox và
  deletion saga.
- ClickHouse là kho dữ liệu phân tích do data-plane service sở hữu cho page facts,
  page metrics, findings, link edges và network/resource facts đã được redaction.
- S3/MinIO lưu screenshot, rendered HTML/DOM và resource body lớn. ClickHouse chỉ
  giữ metadata và stable object identifier, không giữ presigned URL hoặc secret.

ClickHouse không làm queue, distributed lock, idempotency registry, authorization
store hoặc nguồn quyết định trạng thái scan. Frontend và Control Plane không truy
cập ClickHouse trực tiếp; Control Plane authorize rồi gọi query contract của
Crawler/Capture.

### Topology

- Local development có thể chạy một ClickHouse node bằng container.
- Production chạy ClickHouse như dependency độc lập, pin version và migration;
  không dùng chế độ CrawlObserver tải binary rồi chạy subprocess bên cạnh crawler.
- Một physical ClickHouse cluster có hai logical database/role:
  `weblens_crawl_analytics` và `weblens_capture_analytics`.
- Mỗi service chỉ ghi và đọc database analytics của mình. Không có join runtime
  giữa PostgreSQL và ClickHouse hoặc giữa hai database analytics.
- Replica/shard count được chốt bằng capacity/availability benchmark. Workload
  V1/V1.5 hiện tại chưa tự động biện minh cho nhiều shard; production HA profile
  phải được kiểm thử restore/failover trước khi công bố SLO.

### Đường ghi bền vững

Worker không dual-write trực tiếp PostgreSQL và ClickHouse trong cùng code path.
Kết quả page/capture được ghi vào một analytics staging/outbox bền vững trong
PostgreSQL bằng transaction có fencing. Sink riêng claim theo batch, ghi
ClickHouse với deterministic event/version rồi mới đánh dấu delivered và hoàn
tất page/capture trong PostgreSQL.

Nếu ClickHouse xác nhận nhưng PostgreSQL chưa ghi nhận acknowledgement, batch có
thể được gửi lại. Vì ClickHouse không enforce unique key như OLTP database, schema
và query phải xử lý duplicate bằng stable logical key, monotonic version và
version-correct view/query. Không được dựa vào background merge để có correctness
ngay lập tức.

Sink ưu tiên batch lớn và bounded flush interval để tránh tạo quá nhiều data part.
Outbox chưa delivered không bị xóa theo tuổi. Khi backlog vượt ngưỡng, Crawler và
Capture ngừng nhận thêm work có kiểm soát thay vì tăng vô hạn RAM, WAL hoặc disk.

### Đường đọc

- Control Plane phục vụ auth, website, scan/capture summary và trạng thái ingestion
  từ PostgreSQL projection.
- Crawler query API đọc ClickHouse cho page explorer, filter, findings, metric
  distribution và link analytics.
- Capture query API đọc PostgreSQL cho object/snapshot authorization và ClickHouse
  cho network/resource analytics.
- Response phải có freshness/watermark. Scan không được công bố report hoàn chỉnh
  khi analytics watermark chưa đạt terminal result count.

### Phạm vi tái sử dụng CrawlObserver

Được tái sử dụng và sửa đổi parser, URL normalization, robots/sitemap, fetch
pipeline, ClickHouse client/batching và các report query sau khi có contract test.
Không nhập nguyên SQLite auth, Basic Auth, in-memory frontier, managed ClickHouse
subprocess, schema migration gốc, raw header/body policy, Rod renderer, anti-bot
bypass hoặc TLS impersonation.

Schema ClickHouse mới phải thêm tenant/scan/page identity, schema/rule version,
ingestion version, retention timestamp và redaction policy. `body_html` của
CrawlObserver không được chuyển nguyên vào ClickHouse; artifact lớn vẫn ở
S3/MinIO.

## Tính nhất quán và failure mode

- Delivery từ PostgreSQL sang ClickHouse là at-least-once; hiệu ứng đọc là
  idempotent theo logical key/version.
- ClickHouse outage không làm mất accepted work, nhưng có thể đưa scan sang trạng
  thái indexing/degraded và tạo backpressure.
- Event terminal chỉ phát khi durable work đã kết thúc và analytics watermark đã
  đạt số kết quả phải publish; reconciliation sửa acknowledgement bị thiếu.
- Xóa tenant/website/scan là saga. ClickHouse xóa theo partition/batch hoặc mutation
  có theo dõi; Control Plane chỉ báo hoàn tất khi PostgreSQL, ClickHouse và object
  storage đã acknowledgement theo policy.
- Backup/restore của PostgreSQL, ClickHouse và S3/MinIO được kiểm thử độc lập;
  backup consistency xuyên ba hệ thống là recovery workflow, không phải distributed
  snapshot tức thời.

## Bảo mật

- ClickHouse không mở public network; dùng TLS và credential riêng theo service.
- Query luôn nhận owner scope từ service đã authenticate, không tin opaque ID một
  mình và không cho client gửi SQL tùy ý.
- URL, title, heading, header và artifact là dữ liệu không tin cậy; giới hạn byte,
  redaction và output escaping vẫn bắt buộc.
- Raw cookie, `Authorization`, request/response body nhạy cảm và presigned URL
  không được ghi vào ClickHouse.

## Hệ quả

- PostgreSQL tránh gánh toàn bộ analytical scan trên hàng trăm triệu fact row;
  ClickHouse phục vụ filter/aggregation lớn đúng với hướng của CrawlObserver.
- Hệ thống có thêm vận hành, migration, monitoring, backup và failure mode của
  ClickHouse; ứng dụng không thể tuyên bố "chỉ server yếu mới làm sập" nếu chưa
  có backpressure, capacity test và recovery test.
- Schema proposal PostgreSQL-only trước đây tiếp tục bị dừng. Các quyết định vật
  lý cho PostgreSQL staging và ClickHouse table vẫn phải qua cổng RED trước DDL.
- Nghĩa vụ AGPL/provenance của bản fork CrawlObserver trong ADR-005 giữ nguyên.

## Tiêu chí xác minh

- Kill ClickHouse trong lúc crawl không làm mất page result đã được PostgreSQL
  chấp nhận; sau phục hồi, backlog được drain mà không double count.
- Retry cùng batch/event không làm report xuất hiện hai logical result.
- Query report theo owner/scan không rò dữ liệu tenant khác và trả watermark.
- Terminal scan không xuất hiện trước analytics watermark tương ứng.
- Load test ở 200 page result/giây không tạo `too many parts`, backlog không tăng
  vô hạn và p95 report đạt SLO đã phê duyệt.
- Retention/deletion test dọn được PostgreSQL row, ClickHouse fact và S3 object
  theo saga, kể cả khi một dependency tạm thời unavailable.

