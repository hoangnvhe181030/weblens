# TASK-020 — RabbitMQ cho lệnh scan

## Goal / Why

Theo yêu cầu người dùng ngày 2026-10-15, triển khai adapter RabbitMQ cho
`SCAN_REQUESTED` và `SCAN_CANCEL_REQUESTED`, tuân theo ADR-017 revision 2 và
SYS-001/SYS-002. Broker tách bàn giao lệnh khỏi thời điểm Crawler tiếp nhận.
Không khẳng định tăng tốc crawl khi chưa có benchmark workload thật.

## Requirements / API contract

- Ba deployable hiện hữu; JSON envelope/version/message ID giữ nguyên.
- HTTP mặc định; cùng cấu hình transport ở producer và consumer, không dual-publish.
- Persistent, mandatory, bounded publisher confirms; consumer ACK sau commit.
- Dedup/collision/cancellation/version dùng Store PostgreSQL hiện hữu.
- Retry acceptance tối đa 8 lần, backoff; poison/collision/exhaustion vào dead queue
  qua publish có confirm. Handoff lỗi giữ bản gốc chưa ACK.
- Rabbit mode tắt HTTP command acceptance; report/event/capture/clone giữ REST.
- Consumer reconnect có backoff; readiness phụ thuộc kết nối consumer.

## Data changes

Không có DDL, migration hay entity mới. Outbox `DELIVERED` trong Rabbit mode
chỉ mang nghĩa broker handoff; không đồng nghĩa inbox commit hoặc scan hoàn tất.

## Edge cases / Security / Consistency

Mất confirm hoặc ACK tạo duplicate cùng ID; inbox bảo vệ một execution logic.
Hủy đến trước tạo phải retry. Queue/dead queue đầy phải reject publish, giữ công
việc chưa bàn giao. Broker đơn không có HA. User/vhost/ACL provision ngoài runtime;
producer không đọc queue, consumer không declare topology. Giới hạn payload 64 KiB,
strict contract/identity, không log credential/payload; TLS ngoài loopback.
Không giữ transaction DB khi publish. Giữ claim sát worker và lease/fencing hiện hữu.

## Implementation plan

1. Tái dùng dispatcher/outbox Java, thêm AMQP client và cấu hình chọn transport.
2. Thêm consumer Go gọi Store hiện hữu, ACK sau commit và confirmed retry/dead handoff.
3. Provision topology/ACL trong Compose profile local và bổ sung CI integration.
4. Chạy unit, broker/PostgreSQL integration, recovery/backpressure và race checks.
5. Cập nhật kiến trúc, runbook, evidence; review diff và UTF-8.

## Tests / Definition of Done

Java: configuration, HTTP regression, actual broker confirms/identity/persistence,
restart, unroutable, queue rejection và publisher ACL. Go: validation, retry bounds,
real broker+PostgreSQL duplicate/collision, early cancellation, DB outage,
retry exhaustion, shutdown sau commit và failed dead handoff/reconnect.
Build/test đạt; có cách bật local và hướng dẫn chuyển đổi an toàn. Production
rollout/capacity benchmark là bước riêng theo gate ADR-017.
Kết quả local: [evidence 2026-10-15](../docs/testing/RABBITMQ_COMMAND_TRANSPORT_2026-10-15.md).

## What I should understand before accepting this implementation

Outbox bảo vệ transaction tạo lệnh; publisher confirm bảo vệ bàn giao tới broker;
consumer ACK bảo vệ bàn giao tới inbox. Không có distributed transaction giữa ba
bước này, nên có duplicate; ID ổn định và dedup là bắt buộc. Retry này chỉ retry
acceptance, không chạy lại toàn bộ crawl. Dead queue cần operator xử lý.
