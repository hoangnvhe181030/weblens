# Thiết kế lại database V1/V1.5 theo kiến trúc microservice

Trạng thái: hoàn thành thiết kế; schema được phê duyệt ngày 2026-09-11. Migration
review tiếp tục trong TASK-008.

## Mục tiêu

Thiết kế lại persistence boundary cho Spring Boot Control Plane, Go Crawler
Service và Playwright Capture Worker sau ADR-005, đồng thời tuân thủ đầy đủ cổng
thiết kế GREEN/YELLOW/RED.

## Lý do

Schema proposal trước đây giả định một database owner và sử dụng foreign key,
join, transaction xuyên toàn bộ scan/crawler/capture. Giả định đó không còn đúng
khi ba deployable sở hữu dữ liệu độc lập.

## Yêu cầu

- Giữ nguyên migration V1/V2 đã áp dụng và dữ liệu foundation.
- Không có cross-service foreign key, join runtime hoặc distributed transaction.
- Phân loại các bảng hạ tầng mới trước khi thiết kế vật lý.
- Hoàn tất bước 1–7 cho từng nhóm RED trước khi viết schema proposal revision mới.
- PostgreSQL 17.x và ClickHouse tự triển khai theo ADR-006; chưa thêm Kafka hoặc Redis.
- Artifact lớn tiếp tục nằm trong S3/MinIO.

## API contract

Database design phải hỗ trợ versioned REST command/event, idempotency key,
message ID, aggregate sequence, correlation ID và delivery at-least-once. Exact
OpenAPI/event payload nằm ngoài task này nhưng các invariant persistence phải được
ghi rõ.

## Thay đổi dữ liệu

Giai đoạn đầu chỉ tạo tài liệu workload/decision và schema proposal để review.
Không tạo Flyway migration, Go migration, JPA entity hoặc runtime code trước khi
người dùng phê duyệt.

## Trường hợp biên

- Scan commit nhưng dispatch chưa gửi được.
- Command/event trùng hoặc sai thứ tự.
- Worker hết lease rồi gửi kết quả muộn.
- Cancellation cạnh tranh với page completion.
- Crawler terminal nhưng Control Plane thiếu event.
- Upload object thành công nhưng metadata commit thất bại.
- Xóa user/website khi dữ liệu nằm ở ba database.
- Partition retention đang chạy đồng thời với report/worker.

## Cân nhắc bảo mật

- Mỗi service có database role và migration owner riêng.
- Crawler/Capture không nhận user credential.
- `owner_id` từ command là dữ liệu cần validate/audit, không phải FK xuyên service.
- Không lưu raw cookie, Authorization header hoặc body nhạy cảm.
- URL và metadata crawl là input không tin cậy, có giới hạn byte.

## Cân nhắc đồng thời và nhất quán

- Local transaction + outbox/inbox; không giả định exactly-once network delivery.
- Claim dùng `FOR UPDATE SKIP LOCKED`; completion dùng fencing generation.
- Progress là projection có thể reconcile, không phải hot counter được mọi worker ghi.
- Không giữ transaction trong lúc gọi mạng, Chromium hoặc object storage.

## Kế hoạch triển khai

1. Lập bộ quyết định trước schema và phân loại bảng mới.
2. Cập nhật baseline hybrid PostgreSQL/ClickHouse theo ADR-006.
3. Người dùng duyệt workload, ownership, retention và alternatives.
4. Viết schema proposal revision mới theo từng database owner/datastore.
5. Viết benchmark query/concurrency test plan theo từng service.
6. Chỉ sau phê duyệt mới tạo migration forward-only ở task riêng.

## Kiểm thử

- Kiểm tra UTF-8 tiếng Việt và Markdown links.
- Kiểm tra proposal không có cross-service FK/transaction.
- Kiểm tra mọi index có query tương ứng và mọi FK nội bộ có supporting index.
- Chạy PostgreSQL/Testcontainers và concurrency/load test sau khi có migration thử.

## Definition of Done

- Có workload bước 1–7 cho tất cả nhóm bảng V1/V1.5.
- Có ownership và classification cho bảng mới.
- Có schema/index/transaction/benchmark proposal riêng cho ba service.
- Mọi giả thuyết chưa duyệt được đánh dấu rõ.
- Không sửa migration lịch sử.

## Kết quả proposal

- `docs/database/V1_V1_5_HYBRID_SCHEMA_PROPOSAL.md`
- `docs/database/V1_V1_5_HYBRID_BENCHMARK_QUERIES.md`
- Smoke test syntax đã pass trên PostgreSQL 17.6 và ClickHouse 26.3 ngày 2026-09-11.
- Migration review được tách tại `docs/database/migrations-review/`.

## Điều tôi cần hiểu trước khi chấp nhận thiết kế

Database-per-service loại bỏ ACID và FK xuyên boundary. Độ đúng phải đến từ local
constraint, idempotency, monotonic version, fencing, outbox/inbox và reconciliation;
scale ngang vẫn bị giới hạn bởi connection budget, hot key, WAL và autovacuum.
