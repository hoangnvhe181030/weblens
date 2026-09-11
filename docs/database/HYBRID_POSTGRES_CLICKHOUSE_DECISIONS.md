# Bộ quyết định schema hybrid PostgreSQL và ClickHouse

Trạng thái: **Người dùng đã phê duyệt**.  
Ngày lập: 2026-09-11.  
Ngày phê duyệt H1–H10: 2026-09-11.  
Ngày phê duyệt schema hybrid và sáu điểm review vật lý: 2026-09-11.  
Ngày phê duyệt migration review để implementation cục bộ: 2026-09-11.  
Kiến trúc nền: [ADR-006](../adr/ADR-006-tich-hop-clickhouse-cho-analytics.md).

Tài liệu này sửa các quyết định D1, D5, D9, D10 và D11 trong bộ quyết định
PostgreSQL-only trước đó. D2–D4, D6–D8 và D12–D16 tiếp tục áp dụng nếu không mâu
thuẫn với tài liệu này. Đây chưa phải DDL, migration, JPA entity hay Go model.

## 1. Workload và SLO đang dùng

- 20.000 scan/ngày; trung bình 30, p95 80 và tối đa 100 page/scan.
- Khoảng 600.000 page/ngày; đỉnh 200 page result/giây; 100–300 crawler worker.
- Trung bình hai finding/page; page facts và findings giữ 180 ngày.
- Capture duy trì 0,2/giây, burst 2/giây; tối đa 500 network row/capture, 100
  resource body và 50 MiB object/capture.
- Public scan/capture summary giữ 365 ngày; progress projection trễ tối đa hai
  giây. Page report phải công bố analytics watermark/freshness.
- PostgreSQL 17 tự triển khai, ClickHouse tự triển khai và S3/MinIO cho binary lớn.

Đây là workload benchmark đã thống nhất, không phải bằng chứng capacity production.

## 2. Ownership và phân loại RED bổ sung

### PostgreSQL

| Owner | Bảng logic | Vai trò |
| --- | --- | --- |
| Control Plane | `users`, `auth_sessions`, `websites`, `scans`, `capture_requests`, inbox/outbox | OLTP, authorization và public projection |
| Crawler | `crawl_executions`, `scan_pages`, `host_leases`, inbox/outbox | Durable work, lease, retry, fencing và lifecycle |
| Crawler | `analytics_outbox` mới | Staging result bền vững chờ batch sink sang ClickHouse |
| Capture | `capture_jobs`, `page_snapshots`, `capture_objects`, inbox/outbox | Browser work, object lifecycle và publicable metadata |
| Capture | `analytics_outbox` mới | Staging network/resource facts chờ batch sink |

`analytics_outbox` là RED vì payload size, concurrency, WAL, backpressure,
retention và acknowledgement ảnh hưởng trực tiếp tới tính đúng và khả năng sống
của hệ thống.

### ClickHouse

| Database owner | Bảng logic | Vai trò |
| --- | --- | --- |
| Crawler | `page_metrics` | Wide typed page/HTTP/SEO fact có version |
| Crawler | `findings` | Finding theo rule và rule version |
| Crawler | `page_links` | Internal/external link edge phục vụ crawl report |
| Capture | `network_requests` | Network request/response metadata đã redaction |
| Capture | `captured_resources` | Metadata resource và stable object identifier |

Các bảng trên giữ mức RED ban đầu. ClickHouse không có relational PK/FK/unique
constraint tương đương PostgreSQL; bước PK/FK/index của cổng RED phải được thể
hiện bằng logical key, `ORDER BY`, partition key, data-skipping strategy và
ingestion validation.

## 3. Quyết định cần review

### H1 — Topology

Giữ ba logical PostgreSQL database đã đề xuất và bổ sung một physical ClickHouse
cluster với hai logical database/role. Local chạy single node; production topology
chỉ chốt sau benchmark CPU, disk, replication và restore. Không chạy ClickHouse
như subprocess do Crawler quản lý.

### H2 — Nguồn sự thật

PostgreSQL là nguồn sự thật workflow. ClickHouse là nguồn sự thật cho analytical
facts đã publish, nhưng không quyết định queue/lease/cancellation/authorization.
Một page chỉ được tính `COMPLETED` khi sink đã nhận acknowledgement của ClickHouse;
trước đó ở trạng thái `PERSISTING` hoặc `INDEXING`.

### H3 — Đường ghi

Worker transactionally ghi result staging vào PostgreSQL bằng conditional update
có lease owner/generation. Sink claim nhiều row bằng `FOR UPDATE SKIP LOCKED`, tạo
batch ổn định, insert ClickHouse, rồi acknowledgement trong PostgreSQL. Không giữ
PostgreSQL transaction khi gọi ClickHouse.

Retry dùng deterministic batch token và logical result version. ClickHouse vẫn
phải có version-correct query vì deduplication của MergeTree diễn ra bất đồng bộ.

### H4 — Batch và backpressure

Baseline benchmark: 1.000–10.000 row/batch hoặc flush sau tối đa một giây. Mục tiêu
không tạo nhiều small part và vẫn giữ freshness dưới hai giây khi healthy. Nếu
unacked backlog vượt 15 phút ở peak hoặc disk budget đã cấu hình, service dừng
claim URL/capture mới, giữ accepted work bền vững và báo degraded/load-shed.

Không dùng unbounded in-memory buffer. Outbox chưa acknowledgement không purge;
row delivered giữ bảy ngày rồi xóa theo batch nhỏ.

### H5 — Engine, partition và logical key

Baseline là họ `ReplacingMergeTree` có explicit monotonic version cho fact có thể
được retry/correct. Partition theo tháng của immutable scan/capture start time để
quản lý retention; không partition theo tenant hoặc scan. `ORDER BY` bắt đầu bằng
các chiều filter phổ biến và cardinality phù hợp, dự kiến owner/scan rồi page hoặc
rule identity. Thiết kế chính xác phải được quyết định từ benchmark query.

Mọi version của một logical row phải nằm cùng partition. Query cần correctness
tức thời dùng version-safe view/aggregation hoặc `FINAL` trên phạm vi owner/scan;
không chạy `OPTIMIZE ... FINAL` định kỳ như cơ chế correctness.

### H6 — Data shape

`page_metrics` là một wide typed fact cho các signal V1 ổn định, không dùng EAV.
Field thay đổi chậm có schema version; Map/JSON-like field chỉ dành cho phần thật
sự mở rộng và có byte/cardinality cap. `findings` và `page_links` tách riêng vì
cardinality một-nhiều và query pattern khác.

Không lưu raw HTML/body, cookie, Authorization header hoặc presigned URL trong
ClickHouse. Rendered HTML, screenshot và resource body nằm ở S3/MinIO.

### H7 — Report path

Control Plane authorize và proxy. Crawler query ClickHouse cho page explorer,
metrics, findings và links; Capture query ClickHouse cho network/resource facts.
Không cho browser/client kết nối ClickHouse và không cho truyền SQL tùy ý.

Mọi report response có `analytics_watermark`, `is_complete` và thời điểm ingest
gần nhất. Summary lifecycle vẫn đọc PostgreSQL nên ClickHouse chậm không kéo sập
auth/website/scan-list.

### H8 — Retention và deletion

Facts giữ 180 ngày theo monthly partition. Xóa theo retention ưu tiên detach/drop
partition. Xóa sớm một tenant/scan dùng mutation hoặc tombstone/versioned delete
theo thiết kế được benchmark, có audit và acknowledgement; không báo deletion
hoàn tất chỉ vì PostgreSQL đã xóa.

Backup ClickHouse và S3/MinIO có policy riêng; dữ liệu trong backup có thể tồn tại
tối đa theo disclosure 30 ngày như baseline deletion saga.

### H9 — Reconciliation

Crawler/Capture định kỳ so sánh PostgreSQL delivered watermark với ClickHouse
ingestion watermark/count có version. Thiếu batch thì replay; dư duplicate được
version-safe query loại bỏ; mismatch không tự sửa bằng cách giảm progress. Poison
payload được quarantine có giới hạn và làm scan `PARTIAL`/`FAILED` theo policy.

### H10 — Phạm vi fork CrawlObserver

Tái sử dụng parser/fetcher/report intent và ClickHouse client/batch implementation
sau contract test. Không dùng nguyên migration `001_initial.sql`: WebLens cần
owner scope, stable page identity, explicit version, retention, redaction và
schema evolution. SQLite auth, Basic Auth, in-memory frontier, managed binary,
Rod và raw `body_html` không thuộc integration.

## 4. Benchmark bắt buộc trước schema cuối

- Ingest 200, 500 và 1.000 page result/giây; đo part creation, merge pressure,
  ClickHouse p95 insert latency và PostgreSQL staging/WAL/bloat.
- Mất ClickHouse 15 phút tại peak rồi drain backlog; không mất row, không double
  count và không vượt disk/backpressure cap.
- Page explorer theo owner/scan có filter status, content type, depth và pagination.
- Finding distribution/top rules, missing-title/H1 query và metric percentile.
- Internal/external links theo source/target và PageRank input export.
- Capture network waterfall và resource filter theo capture/content type/size.
- Retry cùng batch, out-of-order version, late worker và deletion đang chạy đồng thời.
- Restore một monthly partition và đối chiếu watermark/count với PostgreSQL.

## 5. Điều kiện để viết schema vật lý

H1–H10 đã được phê duyệt. Được phép hoàn tất bước 8–13 để tạo schema proposal
và benchmark proposal cho:

1. PostgreSQL `analytics_outbox` và thay đổi trạng thái/watermark liên quan.
2. ClickHouse page metrics, findings và link edges.
3. ClickHouse network/resource facts.
4. Query-safe dedup/version views, retention và deletion workflow.
5. Benchmark SQL và failure/concurrency test chi tiết.

Schema và migration review đã được phê duyệt cho implementation cục bộ. Control
Plane migration có thể nằm trong Flyway runtime path; Crawler/Capture migration
chỉ được chuyển vào repository do đúng service sở hữu. Chưa cho phép deploy
production hoặc tạo JPA/Go entity nếu chưa có task/runtime review tương ứng.

Tài liệu review tiếp theo:

- [Schema hybrid V1/V1.5](V1_V1_5_HYBRID_SCHEMA_PROPOSAL.md)
- [Benchmark queries hybrid V1/V1.5](V1_V1_5_HYBRID_BENCHMARK_QUERIES.md)
