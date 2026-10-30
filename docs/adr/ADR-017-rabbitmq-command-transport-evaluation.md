# Đánh giá RabbitMQ cho đường giao lệnh scan

Status: Accepted for implementation; controlled single-node VPS rollout authorized
Date: 2026-10-03

## Revision 3 — 2026-10-15

Người dùng yêu cầu triển khai tất cả thay đổi hiện tại lên VPS, bao gồm bật
RabbitMQ. Cho phép rollout có kiểm soát trên một node Windows Server 2019:
RabbitMQ 4.3.6 / Erlang 28.5, fresh credential và ACL riêng, mọi listener chỉ
loopback. Ba deployable và service ownership không đổi. Giữ billing tắt.

Revision này cho phép cutover sau backup/restore drill, đối chiếu không còn lệnh
chờ, health và smoke tạo/hủy scan; không xem benchmark local là capacity proof.
Chấp nhận giới hạn broker đơn không HA; các gate performance 150/300/500 bên
dưới vẫn chưa hoàn tất. Phải đối chiếu inbox thay vì coi publisher confirm là
scan đã tiếp nhận. Khi rollback phải phục hồi cả environment và service dependency.
Kết quả triển khai được ghi riêng trong báo cáo VPS sau kiểm chứng thực tế.

Rollout đã đạt ngày 2026-10-15; xem [evidence VPS](../testing/VPS_RABBITMQ_DEPLOYMENT_2026-10-15.md).
Quyết định này không thay các giới hạn capacity/HA nêu trên.

## Revision 2 — 2026-10-15

Người dùng chọn triển khai RabbitMQ cho command tạo/hủy scan. Mặc định runtime
vẫn là HTTP để release mới không tự chuyển transport của môi trường hiện hữu.
`WEBLENS_SCAN_COMMAND_TRANSPORT=rabbitmq` phải được bật ở cả Control Plane và
Crawler sau khi provision broker. Không fallback hoặc dual-publish tự động.

Adapter giữ PostgreSQL outbox/inbox và contract JSON hiện hữu, không đổi schema.
`DELIVERED` ở chế độ RabbitMQ nghĩa là broker đã confirm/routing thành công;
chỉ inbox Crawler chứng minh command đã được commit. Progress/terminal event,
Capture, Clone và report vẫn dùng REST.

Queue quorum có giới hạn byte và `reject-publish`; producer dùng persistent,
mandatory, publisher confirms. Consumer ACK sau commit; lỗi tạm thời retry với
backoff và bộ đếm header tối đa 8 lần, rồi publish có confirm sang dead queue.
Poison/collision được chuyển thẳng sang dead queue. Không ACK bản gốc nếu việc
publish retry/dead thất bại. Delivery limit của broker đặt -1 để reconnect không
làm broker tự bỏ command; crash trong handoff có thể tạo duplicate cùng ID.
Dead queue không có TTL hoặc consumer tự động; đầy thì giữ công việc chưa ACK
và cần operator xử lý. Đây là admission retry, không retry toàn bộ crawl.

Thêm RabbitMQ Java client (version theo Spring Boot BOM) và client Go chính thức
`amqp091-go`: đây là dependency giao thức AMQP cho hai runtime. Broker local chỉ
bind loopback, credential demo riêng cho producer/consumer; production cần secret,
vhost/ACL riêng và TLS ngoài loopback. Một broker local không chứng minh HA.

Phần benchmark dưới đây là evidence lịch sử. Các gate production và quy trình
đối chiếu trước cutover/rollback vẫn áp dụng; chấp thuận implementation không
đồng nghĩa đã vượt performance gate hoặc đã deploy VPS.

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

## Decision ban đầu — evidence ngày 2026-10-03

Đề xuất tiếp tục đánh giá phương án 1 và 2 trên **handler và PostgreSQL thật**.
Tại thời điểm 2026-10-03, thử nghiệm transport cục bộ đã hoàn thành, chưa có
adapter RabbitMQ trong runtime. Revision 2 ở đầu tài liệu thay thế trạng thái này.

Kết quả ở 500 lệnh tổng hợp, trung vị p95 của ba lần chạy:

| Transport | Consumer/sender đồng thời | p95 bên nhận xử lý xong |
| --- | --- | --- |
| HTTP tuần tự | 1 | 22,098 giây |
| HTTP có giới hạn | 4 | 5,549 giây |
| RabbitMQ | 4, prefetch=1 | 4,232 giây |

RabbitMQ nhanh hơn HTTP 4 luồng khoảng 23,7% trong mẫu 500 này. Ở mẫu 300, một lần
RabbitMQ chậm hơn HTTP 4 luồng. Không khẳng định ưu thế ổn định, mức tăng thông
lượng crawl hoặc capacity 500 người dựa trên thử nghiệm này.

### Thiết kế adapter được triển khai trong revision 2

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

Đánh giá ngày 2026-10-03 chỉ thêm dependency AMQP Java trong công cụ thử nghiệm
độc lập. Revision 2 thêm client Java 5.25.0 theo BOM Spring Boot 3.5.16 vào backend
và `amqp091-go` 1.11.0 vào Crawler; runtime có adapter tùy chọn. Revision 3 cho
phép rollout VPS có kiểm soát. Xem [runbook](../../infra/rabbitmq/README.md) và
[TASK-020](../../tasks/TASK-020-rabbitmq-scan-command-transport.md).

Việc vận hành broker cần theo dõi broker, quyền
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
