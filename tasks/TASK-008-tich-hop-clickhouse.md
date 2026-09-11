# Tích hợp ClickHouse vào data plane WebLens

Trạng thái: migration review đã được phê duyệt; Control Plane V3–V9 đã vào runtime
Flyway để kiểm thử cục bộ. Vẫn BLOCK production deploy cho đến khi có
preflight/benchmark/topology/backup approval.

## Mục tiêu

Tích hợp ClickHouse tự triển khai với bản fork CrawlObserver để lưu và truy vấn
page/link/finding analytics của V1 và network/resource analytics của V1.5, đồng
thời giữ PostgreSQL làm durable workflow store.

## Điều kiện trước khi triển khai

- ADR-006 đã Accepted.
- Người dùng đã phê duyệt H1–H10 ngày 2026-09-11 trong
  `docs/database/HYBRID_POSTGRES_CLICKHOUSE_DECISIONS.md`.
- Schema RED PostgreSQL staging và ClickHouse facts đã được phê duyệt ngày
  2026-09-11 để tạo migration review; chưa được deploy hoặc sinh entity/runtime.
- Đã chọn/pin ClickHouse version, backup profile và production topology.

## Phạm vi

- ClickHouse local development dependency và migration runner thuộc từng owner.
- PostgreSQL analytics staging/outbox có fencing và bounded backpressure.
- Go batch sink cho crawl analytics; Capture batch sink cho capture analytics.
- Query API có owner scope, bounded filter/pagination và watermark.
- Reconciliation, retention, deletion acknowledgement và observability.
- Contract/load/failure/security test; giữ provenance AGPL cho code fork.

## Ngoài phạm vi

- ClickHouse làm queue, auth store hoặc lifecycle source.
- Kafka, Redis, Kubernetes và cross-service direct database access.
- Bê nguyên SQLite auth, in-memory frontier, Rod hoặc migration gốc của CrawlObserver.
- Lưu raw HTML/screenshot/resource body trong ClickHouse.

## Failure mode bắt buộc kiểm thử

- ClickHouse unavailable trước/sau insert acknowledgement.
- PostgreSQL acknowledgement thất bại sau ClickHouse success.
- Duplicate batch, version đến sai thứ tự và worker cũ ghi muộn.
- `too many parts`, disk watermark, slow merge và query overload.
- Retention/deletion chạy đồng thời với report và ingestion.
- Tenant ID hợp lệ nhưng sai owner, SQL/filter abuse và dữ liệu crawl độc hại.

## Definition of Done

- Không mất accepted result khi restart hoặc dependency outage có giới hạn.
- Report không double count, có freshness/watermark và không rò tenant.
- Backpressure giữ RAM/WAL/disk trong cap đã cấu hình.
- Benchmark đạt ingestion/report SLO trên hardware profile được ghi lại.
- Restore/reconciliation/deletion test pass cho PostgreSQL, ClickHouse và S3/MinIO.
- Encoding tiếng Việt, tài liệu, license notices và dependency rationale đều pass.

## Artifact migration review

- `docs/database/migrations-review/README.md`
- PostgreSQL Control Plane V3–V9, gồm ba concurrent-index sidecar Flyway.
- PostgreSQL Crawler V1–V2 và partition bootstrap.
- PostgreSQL Capture V1.
- ClickHouse Crawl/Capture migration 001.

## Điều developer cần hiểu trước khi chấp nhận

ClickHouse tối ưu cho append/batch/analytics chứ không thay thế transaction và
unique constraint của PostgreSQL. Correctness đến từ durable staging, fencing,
logical key/version, version-safe query, watermark và reconciliation; background
merge không phải cam kết exactly-once.
