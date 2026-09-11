# V1 — Vertical slice Control Plane và Crawler Service

Trạng thái: **Đã triển khai code; còn chờ kiểm thử end-to-end với ClickHouse thật
và production preflight**.

## Goal

Hoàn thiện luồng V1 từ lúc người dùng tạo scan đến khi Crawler Service nhận lệnh
idempotent, crawl HTTP có giới hạn, lưu workflow bền vững, công bố tiến độ và đưa
page analytics vào ClickHouse theo batch.

## Why

Trước TASK-009, backend chỉ tạo scan ở trạng thái `QUEUED`. Vertical slice hiện đã
có durable command/event delivery, crawler workflow và page report. V1 chưa được
coi là production-ready cho đến khi failure test với PostgreSQL/ClickHouse thật,
benchmark và quy trình backup/restore hoàn tất.

## Requirements

- Control Plane persist scan và outbox command trong cùng transaction.
- Crawler nhận command version 1, xác thực service token, dedup theo `message_id`
  và `scan_id`, rồi tạo execution cùng seed page trong một transaction.
- Crawler dùng PostgreSQL làm nguồn lifecycle/frontier; không dùng queue trong RAM
  làm nguồn đúng-sai và không đọc database của Control Plane.
- Fetch chỉ cho HTTP(S), kiểm tra IP sau DNS và từng redirect, giới hạn thời gian,
  response bytes, page count, depth, redirect và concurrency.
- Page result được ghi vào PostgreSQL analytics outbox trước khi gửi ClickHouse.
- Event progress/terminal được ghi vào crawler outbox trước khi callback Control
  Plane; callback trùng hoặc sai thứ tự không làm projection quay ngược.
- Không thêm Kafka, Redis, Kubernetes, SQLite auth, Rod hoặc Cloudflare bypass.

## API contract

- `POST /internal/v1/commands/scans` trên Crawler nhận envelope version 1 gồm
  `messageId`, `aggregateId`, `aggregateVersion`, `correlationId`, `occurredAt`
  và payload snapshot của scan/website/policy.
- `POST /internal/v1/events/scans` trên Control Plane nhận progress/terminal
  envelope version 1.
- Hai endpoint yêu cầu `X-WebLens-Service-Token`; payload JSON tối đa 64 KiB.
- Duplicate hợp lệ trả success idempotent; cùng ID nhưng payload khác bị từ chối.

## Data changes

- Không tạo schema mới. Control Plane dùng `outbox_events`/`inbox_messages` đã có
  trong V8.
- Crawler runtime dùng nguyên nội dung đã duyệt của PostgreSQL V1/V2 và ClickHouse
  migration 001 trong `docs/database/migrations-review/`.
- Không có foreign key, join hoặc transaction xuyên service.

## Edge cases

- Control Plane commit nhưng Crawler đang down.
- Crawler đã commit command nhưng HTTP acknowledgement bị mất.
- Duplicate command, message ID collision, event đến sai thứ tự.
- DNS trả cả IP public và private, redirect sang metadata/private network.
- Trang quá lớn, content type không phải HTML, malformed HTML, redirect loop.
- Worker mất lease hoặc process restart giữa fetch và persist.
- ClickHouse nhận batch nhưng PostgreSQL chưa ghi acknowledgement.

## Security considerations

- So sánh service token constant-time; không log token, raw header, cookie hoặc body.
- Chỉ dùng target snapshot do Control Plane cấp và vẫn kiểm tra SSRF ở lúc kết nối.
- Không chuyển user credential sang Crawler.
- Giới hạn request body, URL, error message và analytical payload.

## Concurrency / consistency considerations

- Claim work bằng `FOR UPDATE SKIP LOCKED`, lease có generation/fencing token.
- Mọi cập nhật page result kiểm tra worker và lease generation hiện hành.
- Delivery là at-least-once; inbox/outbox và ClickHouse logical version loại bỏ
  double count.
- Không giữ PostgreSQL transaction trong lúc gọi HTTP target, Control Plane hoặc
  ClickHouse.

## Implementation plan

1. Thêm command outbox và event inbox vào Control Plane.
2. Tạo deployable Go Crawler có config, health, service auth và migration runner.
3. Chuyển đổi có provenance các phần URL normalization, HTML parsing và safe dial
   từ CrawlObserver; loại bỏ TLS impersonation/browser bypass.
4. Triển khai PostgreSQL command acceptance, page lease/frontier và result commit.
5. Triển khai ClickHouse batch sink và crawler event publisher.
6. Bổ sung local Compose, tài liệu chạy và CI/test commands.

## Tests

- Java unit/integration: scan + outbox atomic, event dedup/version monotonic và
  service authentication.
- Go unit: normalize/scope, SSRF policy, redirect, parser, contract validation.
- PostgreSQL integration: duplicate command, concurrent claim, stale fencing,
  restart/reclaim và terminalization.
- ClickHouse integration: duplicate batch, version cũ, receipt và current views.
- End-to-end: create scan → crawl test site → report/progress terminal.

## Kết quả triển khai ngày 2026-09-11

- Control Plane ghi scan và command outbox trong cùng local transaction; dispatcher
  có lease, retry và idempotency key.
- Control Plane chặn một scan active/website và quá ba scan active/user; inbox khóa
  theo message ID để callback trùng đồng thời có kết quả idempotent ổn định.
- Crawler Go nhận start/cancel command có version, xác thực service token, duy trì
  execution/frontier/lease trong PostgreSQL và không giữ transaction khi gọi mạng.
- Fetcher có giới hạn page/depth/bytes/time/concurrency, robots policy, redirect
  scope và SSRF guard ở DNS lẫn lúc dial.
- Page result được stage trong PostgreSQL, gom tối đa 100 bundle/flush và ghi
  ClickHouse theo at-least-once có receipt/version rồi mới hoàn tất page và phát
  progress. Backlog chưa ack quá 15 phút dừng page claim và làm readiness degraded.
- Control Plane nhận event theo inbox/version đơn điệu và cung cấp page list/page
  detail có owner scope cho frontend backend mode.
- Unit/build checks Java, Go và frontend đã pass. Compose static config đã pass.
- Control Plane smoke test trên PostgreSQL 18.4 thật đã chạy đủ 9 Flyway migration,
  register user, tạo website, xác minh quota 1 active scan/website và 3 active
  scan/user. Mười callback cùng message ID gửi đồng thời cho kết quả 1 applied và
  9 duplicate, tất cả trả HTTP 200.
- Crawler integration test đã chạy trên PostgreSQL 18.4 cục bộ và xác minh
  migration, command dedup/collision, analytics acknowledgement, cancellation,
  lease reclaim, fencing và các race claim/heartbeat với cancellation. Target
  PostgreSQL 17.6 vẫn cần được chạy lại trong Compose trước release.
- ClickHouse integration suite cho migration, batch insert và replay/receipt đã
  được thêm vào CI, nhưng chưa chạy cục bộ vì Docker Desktop hiện không hoạt động.
  Full cross-service end-to-end, ClickHouse failure injection và benchmark chưa
  được chạy trong vòng này. Java Testcontainers build thành công nhưng skip 14
  integration tests do không có Docker. Không được dùng kết quả hiện tại để công
  bố production readiness.

## Definition of Done

- Accepted scan không mất khi một service restart trong failure tests.
- Duplicate command/event không tạo execution hoặc tăng progress hai lần.
- Crawler không kết nối được private/reserved destination ngoài test policy rõ ràng.
- PostgreSQL, ClickHouse, Java và Go test phù hợp đều pass.
- License/provenance và tài liệu tiếng Việt được kiểm tra.

## What I should understand before accepting this implementation

Outbox/inbox tạo atomicity cục bộ và idempotency, không tạo exactly-once transport.
Lease generation ngăn worker cũ ghi đè kết quả mới. ClickHouse là projection có
thể trễ; PostgreSQL vẫn quyết định lifecycle và khả năng recovery.
