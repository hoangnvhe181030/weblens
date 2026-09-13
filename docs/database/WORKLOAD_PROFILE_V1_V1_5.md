# Hồ sơ workload và độ tin cậy V1/V1.5

Trạng thái: các mục tiêu tải được người dùng phê duyệt ngày 2026-09-10; ranh giới
thực thi được cập nhật ngày 2026-09-11 theo ADR-005/ADR-006. Đây không phải số liệu
production đã đo được. Sau khi có traffic thật, phải thay giả thuyết bằng số liệu
quan sát và kiểm tra lại capacity.

## Mục tiêu phi chức năng

WebLens V1/V1.5 phải production-ready trong phạm vi tải đã định lượng. API và
worker phải có khả năng scale theo chiều ngang; PostgreSQL và ClickHouse tự triển
khai được sử dụng trong giới hạn đã benchmark; binary lớn nằm trong object storage. Khi vượt capacity,
hệ thống phải áp dụng queue, quota, backpressure và load shedding để bảo vệ request
tương tác, không làm sai dữ liệu đã chấp nhận và có thể tự phục hồi.

Không có hệ thống chịu tải vô hạn. “Server mạnh hơn” chỉ tăng capacity; nó không
sửa được hot row, query xấu, transaction dài, connection storm, retry trùng, thiếu
backpressure, website đích chậm hoặc object storage bị lỗi.

## Mục tiêu benchmark ban đầu

| Chỉ số | Mục tiêu được duyệt |
| --- | ---: |
| Tổng tài khoản | 100.000 |
| Daily active users | 10.000 |
| Client đồng thời | 1.000 |
| Trần stress test của load runner | 100.000 virtual user hữu hạn |
| API traffic duy trì | 300 request/giây |
| API burst | 1.000 request/giây trong 5 phút |
| Page result được commit vào Crawler persistence ở mức đỉnh | 200 page/giây |
| Crawl worker hữu dụng trong benchmark chuẩn | 100–300 |
| Trần active page-fetch slot cấu hình | 10.000 |
| Browser worker đồng thời | 10 |
| Capture duy trì | 0,2 capture/giây |
| Capture burst | 2 capture/giây |
| Đọc tiến độ scan | p95 dưới 200 ms |
| Tạo scan/capture | p95 dưới 300 ms |
| Report và page detail | p95 dưới 500 ms |
| Tỷ lệ lỗi API trong tải chuẩn | dưới 0,1% |

Các mục tiêu trên phải được kiểm tra bằng workload có phân bố dữ liệu thực tế,
không chỉ benchmark một truy vấn trên database rỗng hoặc cache đã nóng hoàn toàn.
Runtime capacity cao và cách phân biệt connection/thread/worker/virtual user được
ghi tại [PRODUCTION_HIGH_CAPACITY_WORKLOAD.md](PRODUCTION_HIGH_CAPACITY_WORKLOAD.md).

## Hành vi bắt buộc khi quá tải

1. Authentication, website, đọc tiến độ và đọc kết quả đã có được ưu tiên.
2. Scan/capture mới có thể bị trì hoãn hoặc từ chối bằng `429`/`503` và
   `Retry-After`; hệ thống không nhận vô hạn rồi sập dây chuyền.
3. Công việc đã được chấp nhận phải tồn tại bền vững qua restart.
4. Worker chạy theo at-least-once; persistence phải idempotent và có fencing để
   từ chối kết quả của owner/attempt đã hết hiệu lực.
5. Queue phải có giới hạn, quota theo user/website và điều phối công bằng.
6. Background ingestion không được dùng hết database connection dành cho API.
7. Khi tải giảm, hệ thống phải tự phục hồi mà không cần sửa dữ liệu thủ công.

## Ranh giới thực thi

- **Spring Boot Control Plane:** authentication, website, tạo/hủy scan/capture,
  public lifecycle, progress projection và API/BFF. Các đường này phải giữ latency
  thấp khi Crawler/Capture bị chậm.
- **Go Crawler Service:** durable execution/frontier, crawl, parse, metrics,
  deterministic findings và page-level report query. Service này được phép xếp
  hàng và backpressure trước control-plane reads.
- **Playwright Capture Worker:** browser render, upload object và capture metadata.
  Service này có concurrency/egress/resource budget riêng.
- Dispatch và event delivery giữa service là at-least-once qua versioned REST và
  PostgreSQL outbox/inbox; duplicate và out-of-order phải được xử lý idempotently.
- Không giữ database transaction khi gọi website, chạy Chromium hoặc upload object.
- Không giữ database transaction khi gọi service khác. Không dùng distributed
  transaction hoặc cross-service foreign key.
- PostgreSQL persistence thuộc từng service lưu trạng thái và metadata có cấu trúc;
  S3/MinIO lưu screenshot, rendered HTML và resource body lớn.
- V1/V1.5 chưa tự động thêm Kafka, Redis hoặc Kubernetes. Chỉ bổ sung khi benchmark
  chứng minh REST + PostgreSQL outbox/inbox hoặc mô hình deploy hiện tại không đạt.

## Mục tiêu handoff và recovery giữa service

- API chỉ trả accepted sau khi Control Plane commit scan/capture request và dispatch
  outbox; Crawler/Capture chưa sẵn sàng không được làm mất request.
- Trong tải chuẩn, dispatch age và event projection lag p95 phải nằm trong mục tiêu
  progress tối đa 2 giây đã duyệt; khi degraded phải có metric/alert và trạng thái
  stale rõ ràng.
- Cùng một command/event được gửi lặp lại ít nhất ba lần trong failure test nhưng
  chỉ tạo một logical execution và chỉ tăng progress một lần.
- Restart lần lượt Control Plane, Crawler, Capture Worker và PostgreSQL connection;
  accepted work phải tự tiếp tục hoặc được reclaim trong recovery SLO đã duyệt.
- Crawler/Capture unavailable không được gây connection/thread exhaustion ở
  Control Plane. Retry phải bounded, có backoff/jitter và circuit breaking.
- Reconciliation phải sửa projection bị thiếu mà không sửa evidence đã commit hoặc
  làm terminal state quay lại running.

## PostgreSQL tự triển khai và quản lý connection

Ngày 2026-09-10, người dùng quyết định không dùng Neon và tự triển khai PostgreSQL.
Domain model không thay đổi, nhưng nhóm phát triển chịu trách nhiệm trực tiếp về
nâng cấp, bảo mật hệ điều hành, storage, connection pool, backup, restore, PITR,
replication/failover, monitoring và xử lý sự cố.

- Dùng PostgreSQL 17.x và cập nhật minor release mới nhất trước production. Tại
  ngày quyết định, bản mới nhất là 17.11; Compose/Testcontainers hiện còn pin
  17.6 và phải được nâng cấp/xác minh trong một task riêng.
- Đặt PgBouncer transaction pooling trước PostgreSQL. Control Plane dùng HikariCP;
  Crawler/Capture dùng pool có giới hạn phù hợp driver của chúng. Tổng connection
  budget được tính trên mọi instance và mọi database/schema cùng cluster; không
  nhân pool không giới hạn khi scale ngang.
- PostgreSQL production phải luôn hoạt động; không còn khái niệm scale-to-zero.
- Sizing dựa trên working set, write throughput, WAL, autovacuum và latency đã đo.
  Mọi benchmark phải ghi CPU, RAM, storage/IOPS, filesystem, cấu hình PostgreSQL,
  số connection và trạng thái cache.
- Phải có base backup kết hợp continuous WAL archiving để hỗ trợ PITR, backup nằm
  trên failure domain khác và restore drill định kỳ. `pg_dump` bổ sung khả năng
  phục hồi logic nhưng không thay thế PITR cho database lớn.
- Streaming standby/read replica chỉ được chọn sau khi chốt RPO/RTO và độ trễ đọc.
  Có replica không đồng nghĩa với tự động failover; phải tránh split-brain và kiểm
  thử chuyển primary.
- Theo dõi disk/WAL, connection/pool wait, transaction dài, lock wait, query
  p95/p99, dead tuple/autovacuum, replication lag, cache hit và tốc độ tăng dữ liệu.

Tài liệu tham khảo:

- https://www.postgresql.org/docs/17/release-17-11.html
- https://www.postgresql.org/docs/17/continuous-archiving.html
- https://www.postgresql.org/docs/17/warm-standby.html

## Ranh giới version và migration

Phạm vi sản phẩm tập trung vào V1 và V1.5. Điều này không giới hạn số Flyway
migration nội bộ: schema vẫn tiến hóa bằng nhiều forward migration nhỏ, bất biến
sau khi áp dụng và có kiểm thử riêng.

## Điều kiện hoàn tất mục tiêu

- Chạy tải chuẩn và tải burst với latency/error SLO nêu trên.
- Chạy quá tải 2–3 lần để xác minh backpressure và load shedding.
- Kiểm tra worker crash, retry, kết quả đến muộn và cancellation race.
- Kiểm tra commit-before-dispatch, duplicate command/event, event sai thứ tự,
  callback timeout và restart từng service độc lập.
- Chứng minh không mất job đã nhận, không double-count và không chuyển state sai.
- Đo queue depth/age, pool wait, lock wait, throughput ghi, query p95/p99, dead
  tuple/autovacuum, cache hit và tốc độ tăng storage.
- Ghi cấu hình server/PostgreSQL dùng trong benchmark; không tuyên bố throughput nếu
  thiếu cấu hình, dataset, thời lượng và phân bố tải.
