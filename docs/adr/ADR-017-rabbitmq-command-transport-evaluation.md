# Đánh giá RabbitMQ cho đường giao lệnh scan

Status: Proposed  
Date: 2026-10-03

## Context

Người dùng đồng ý kế hoạch đánh giá RabbitMQ ngày 2026-10-03. ADR-005 hiện chọn
REST cùng PostgreSQL outbox/inbox và yêu cầu benchmark trước khi thêm broker.
Sự đồng ý cho phép chuẩn bị và chạy thử nghiệm; bằng chứng cục bộ dưới đây chưa
đủ để thay quyết định transport của production.

Source production được đối chiếu là commit `91f1d35e0944573af7904648908b58430dd56f4f`.
`CrawlerCommandDispatcher` claim tối đa 25 command rồi gửi HTTP tuần tự; lịch gọi
có fixed delay 0,5 giây sau khi dispatch trả về. Outbox lease mặc định 30 giây,
connect timeout 2 giây và read timeout 10 giây. Một lô bị chậm có thể vượt lease
của các command chưa bắt đầu; chưa quan sát lỗi này ở lượt 150 đã đo.

Đối chiếu read-only lượt `worker64-150-runtime-v1-20261003T062608Z`:

- 146 command/146 inbox đúng message, aggregate, version và owner; tất cả
  DELIVERED/APPLIED, delivery_attempts=1, không có last_error_code.
- Control outbox created→delivered p95 19,9695 giây, đo trên cùng clock Control.
- Control created→crawler accepted_at p95 19,88675 giây; clock khác service chưa
  có sai số đồng bộ được đo. accepted_at được lấy trước transaction commit.
- Crawler accepted→started p95 4,636 giây, không phải thời gian chờ outbox.
- Bốn admission timeout vẫn là lỗi; không có command/scan được quan sát cho chúng.
- Không có claim-start trace để tách thời gian chờ, HTTP và xử lý database.
  Inbox received_at/processed_at dùng cùng timestamp, không đo handler duration.

Chi tiết phương pháp và bằng chứng:
[PERFORMANCE_DISPATCH_EVALUATION_2026-10-03.md](../testing/PERFORMANCE_DISPATCH_EVALUATION_2026-10-03.md).

## Options considered

1. **Giữ HTTP, cải thiện dispatcher:** cấp việc và gửi song song có giới hạn,
   claim sát thời điểm thực thi, đo lease và thời gian từng bước. Chi phí vận hành
   thấp nhất; vẫn dùng outbox/inbox hiện hữu.
2. **RabbitMQ cho lệnh scan:** producer outbox→broker→consumer inbox; tách tốc độ
   giao lệnh khỏi tốc độ tiếp nhận và có phân phối tới nhiều consumer. Thêm broker,
   quyền truy cập, xác nhận, hàng đợi lỗi và đối chiếu vận hành.
3. **Kafka:** chỉ xem xét khi có workload yêu cầu lưu/replay luồng sự kiện và nhiều
   nhóm tiêu thụ độc lập. Hiện chưa có yêu cầu này để ưu tiên Kafka.

## Decision

Đề xuất tiếp tục đánh giá phương án 1 và 2 trên **handler và PostgreSQL thật**.
Thử nghiệm transport cục bộ đã hoàn thành, chưa có adapter RabbitMQ trong runtime.

Kết quả ở 500 lệnh tổng hợp, trung vị p95 của ba lần chạy:

| Transport | Consumer/sender đồng thời | p95 bên nhận xử lý xong |
| --- | --- | --- |
| HTTP tuần tự | 1 | 22,098 giây |
| HTTP có giới hạn | 4 | 5,549 giây |
| RabbitMQ | 4, prefetch=1 | 4,232 giây |

RabbitMQ nhanh hơn HTTP 4 luồng khoảng 23,7% trong mẫu 500 này. Ở mẫu 300, một lần
RabbitMQ chậm hơn HTTP 4 luồng. Không khẳng định ưu thế ổn định, mức tăng thông
lượng crawl hoặc capacity 500 người dựa trên thử nghiệm này.

### Thiết kế adapter thử nghiệm tiếp theo

- Phạm vi đầu là SCAN_REQUESTED và SCAN_CANCEL_REQUESTED giữa Control và Crawler.
  Public HTTP admission và report API tiếp tục cần được đo riêng.
- Giữ PostgreSQL là nguồn trạng thái và frontier; tái sử dụng envelope, version,
  message ID, owner, inbox dedup và lease/fencing. Broker không thay giới hạn host.
- Chọn transport ở cấu hình với giá trị mặc định HTTP; mỗi producer chỉ kích hoạt
  một đường gửi. Không tự chuyển sang đường thứ hai khi gặp timeout.
- Producer dùng message persistent, mandatory routing và publisher confirms có
  timeout. Mất confirmation có thể tạo duplicate khi retry; ID phải giữ nguyên.
- **Broker confirm không phải crawler commit.** Nếu outbox DELIVERED được dùng để
  ghi broker handoff, phải công bố thay đổi nghĩa này và đo consumer acceptance
  riêng. Không dùng broker-confirm time để thay tiêu chí nhận đủ scan.
- Consumer kiểm tra contract, payload bounds và identity; xác nhận sau inbox và
  execution commit, không đợi toàn bộ crawl. Kiểm tra message ID trùng nhưng payload
  khác phải từ chối. Version/state bảo vệ cancellation và message sai thứ tự.
- Dùng queue quorum bền vững và dead-letter queue; retry có backoff và giới hạn
  được kiểm thử. Không dựa duy nhất vào số lần basic.nack vì cách đếm phụ thuộc
  phiên bản/cơ chế reject. Poison message phải còn evidence trong hàng đợi lỗi.
- Broker dùng mạng riêng, TLS khi qua mạng, vhost/role riêng cho publisher và
  consumer. Credential không đi trong payload hoặc log. Envelope vẫn là input
  cần xác minh, không bỏ validation vì broker đã xác thực connection.
- Một broker đơn chỉ phù hợp thử nghiệm/đánh giá chi phí, không có khả năng chịu
  mất node. Nếu cần tiếp tục phục vụ khi hỏng node, phải đánh giá quorum trên ba
  node và chi phí tương ứng trước deployment.
- Event hoàn tất và Capture chưa chuyển ở thử nghiệm đầu; terminal event lag
  p95 0,486 giây tại tải 150 chưa chứng minh cần đổi transport cho event.

### Điều kiện đánh giá trước production

1. Chạy cùng dataset, handler, PostgreSQL và ngân sách consumer cho HTTP và RabbitMQ.
   Đo created→claim, request/publish, confirm, consumer commit và first-page riêng.
2. Kiểm thử broker/consumer restart, publish mất confirmation, duplicate/collision,
   cancellation đến trước create, version cũ, queue đầy và lỗi DB có thời hạn.
3. Không mất scan đã nhận, không tạo execution trùng, trạng thái/owner/version đúng.
   Đối chiếu message còn chờ, unacked và dead-letter với outbox/inbox trong scope.
4. Đo mixed scan+API tăng 150→300→500 sau khi candidate được triển khai theo quy
   trình riêng. Giữ SLO errors<1% và API p95<1 giây; API chạy xuyên suốt crawl nếu
   đánh giá hoạt động liên tục. Admission timeout và lỗi startup/login vẫn tính.
5. Chọn broker khi lợi ích trên workload thật hoặc nhu cầu chịu lỗi/mở rộng bù được
   chi phí thêm. Không chọn chỉ vì có 500 tài khoản.
6. Trước chuyển đổi/quay lại HTTP: dừng producer theo luồng, đối chiếu command trong
   broker/inbox/outbox và tiếp tục bằng cùng ID. Không tự phát lại tất cả outbox
   DELIVERED; lệnh hủy đang chờ cũng phải được đối chiếu.

## Consequences

Đánh giá mới thêm dependency AMQP Java **chỉ trong công cụ thử nghiệm độc lập**,
khớp phiên bản 5.25.0 được BOM Spring Boot 3.5.16 của backend quản lý. Không có
dependency RabbitMQ trong artifact production hiện tại.

Việc áp dụng broker sẽ cần thư viện client cho Java và Go, theo dõi broker, quyền
truy cập và thao tác đối chiếu mới. Broker không làm nhanh query ClickHouse hay
transaction claim page; các đường này vẫn cần tối ưu nếu giới hạn pages/s tồn tại.

Không đề xuất DDL hoặc index mới ở revision này. Nếu adapter cần thay schema,
phải áp dụng DESIGN_GATES và review tương ứng; index revision 1 vẫn pending.

## When to revisit

Sau benchmark với PostgreSQL/handler thật, hoặc khi yêu cầu multi-consumer,
durable handoff, broker availability hay replay thay đổi.

## References

- [RabbitMQ acknowledgments và confirms](https://www.rabbitmq.com/docs/confirms)
- [RabbitMQ quorum và dead-letter behavior](https://www.rabbitmq.com/docs/quorum-queues)
- [RabbitMQ Java client](https://www.rabbitmq.com/client-libraries/java-api-guide)
- [ADR-005](ADR-005-tach-crawler-thanh-microservice.md)
