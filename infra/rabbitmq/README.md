# RabbitMQ scan command runbook

Phạm vi: `SCAN_REQUESTED`/`SCAN_CANCEL_REQUESTED`, Control Plane → Go Crawler.
Theo [ADR-017](../../docs/adr/ADR-017-rabbitmq-command-transport-evaluation.md).
Event/report/Capture/Clone dùng REST; PostgreSQL vẫn sở hữu workflow.

## Bật local

Từ repository root, với Docker Engine đang chạy:

```powershell
docker compose --env-file .env -f infra/compose.yml --profile rabbitmq up -d --wait rabbitmq
```

Nếu chưa có `.env`, tạo từ `.env.example` theo hướng dẫn ở README gốc. Broker
demo bind `127.0.0.1:5672`, management `127.0.0.1:15672`; volume
`weblens-rabbitmq-data` giữ message qua restart. Không xóa volume để xử lý lỗi.
Trong **cả terminal backend và terminal Crawler**, giữ các biến môi trường
database/auth/event đang dùng và thêm:

```powershell
$env:WEBLENS_SCAN_COMMAND_TRANSPORT='rabbitmq'
$env:WEBLENS_RABBITMQ_HOST='127.0.0.1'
$env:WEBLENS_RABBITMQ_PORT='5672'
$env:WEBLENS_RABBITMQ_VHOST='weblens'
$env:WEBLENS_RABBITMQ_TLS='false'
$env:WEBLENS_RABBITMQ_USERNAME='weblens_control'
$env:WEBLENS_RABBITMQ_PASSWORD='weblens-control-local-only'
$env:CRAWLER_RABBITMQ_USERNAME='weblens_crawler'
$env:CRAWLER_RABBITMQ_PASSWORD='weblens-crawler-local-only'
$env:CRAWLER_RABBITMQ_CONCURRENCY='4'
```

Sau đó chạy backend `./mvnw.cmd spring-boot:run` trong `backend` và
`go run ./cmd/weblens-crawler` trong `crawler`. Hai process cần được truyền biến
môi trường; file `.env` của Compose không tự nạp vào terminal backend/Crawler.
Nếu port Compose đã đổi, đặt cùng port ở hai process.

Credentials trên là **demo công khai, chỉ dành cho local**. Management dùng
`weblens_admin` / `weblens-admin-local-only`. Production provision user/password,
vhost, ACL và topology riêng; không import demo users. Runtime không có quyền
declare topology. Ngoài loopback bắt buộc `WEBLENS_RABBITMQ_TLS=true`, port TLS
của broker và certificate được hệ thống/JVM tin cậy; không bỏ hostname validation.

## Topology và semantics

| Thành phần | Giá trị |
| --- | --- |
| Command exchange / routing key | `weblens.scan.commands` / `scan` |
| Command quorum queue | `weblens.scan.commands.v1` |
| Dead exchange / routing key | `weblens.scan.dead` / `rejected` |
| Dead quorum queue | `weblens.scan.dead.v1` |
| Body tối đa | 64 KiB UTF-8 JSON |
| Queue limit | 64 MiB body ở trạng thái ready; `reject-publish` |
| Consumer | Mặc định 4 kết nối, prefetch 1; cấu hình 1–16 |
| Acceptance retry | 8 lần: 0,5 / 1 / 2 / 4 / 8 / 10 / 10 / 10 giây |

Producer giữ message/correlation ID của outbox, persistent + mandatory + confirms.
`DELIVERED` nghĩa là broker nhận/route thành công; không chứng minh execution đã
commit. Consumer kiểm tra envelope và ID, commit inbox/execution rồi ACK.
Poison/collision vào dead queue ngay. Lỗi DB hoặc cancellation chưa có execution
retry acceptance; hết retry vào dead queue. Republish retry/dead có confirm trước
ACK bản gốc. Handoff lỗi đóng connection, broker giao lại bản gốc. Duplicate có
thể xảy ra; inbox dedup giữ một execution logic.

Delivery limit -1 tránh broker tự bỏ bản gốc khi reconnect. Dead queue không TTL,
không auto-consumer. Queue đầy, disk/memory alarm hoặc binding lỗi cần operator
xử lý; client không báo thành công khi chưa confirm/routing. Một node local
không chịu được mất node/volume; production cần quyết định HA/backup theo workload.

## Kiểm tra và xử lý lỗi

```powershell
docker compose --env-file .env -f infra/compose.yml --profile rabbitmq exec rabbitmq rabbitmqctl list_queues -p weblens name messages_ready messages_unacknowledged consumers
docker compose --env-file .env -f infra/compose.yml --profile rabbitmq logs --tail 100 rabbitmq
Invoke-RestMethod http://127.0.0.1:8081/health/ready
```

Rabbit mode: Crawler command HTTP trả 503 `COMMAND_TRANSPORT_DISABLED`.
Readiness trả 503 nếu chưa đủ consumer kết nối; report API vẫn có route riêng.
Theo dõi outbox status/attempt/error/age, command ready/unacked, số consumer,
inbox acceptance và dead queue. Broker confirm lag không thay consumer commit lag.

Dead queue cần đối chiếu `messageId`, `correlationId`, payload và
`x-weblens-reason` với outbox/inbox bằng quyền operator. Không purge hoặc ACK
message trước khi có bản lưu và quyết định xử lý. Replay chỉ sau khi sửa nguyên
nhân, bằng cùng ID/envelope và publisher role được phép; reset retry header khi
operator chủ động retry. Collision phải điều tra, không sửa payload của cùng ID.

## Cutover / rollback

1. Chặn admission tạo/hủy scan mới; dừng dispatcher Control Plane có kiểm soát.
2. Cho transport cũ xử lý hết lệnh; đối chiếu outbox, inbox và queue/dead queue.
   Với RabbitMQ, đợi ready/unacked về 0, xác minh mọi lệnh trong scope đã vào
   inbox hoặc được xử lý riêng. Dead queue chưa giải quyết là gate chưa đạt.
3. Khi còn backlog, giữ transport cũ hoặc lập kế hoạch replay từng ID đã đối chiếu.
   Không phát lại hàng loạt outbox `DELIVERED`.
4. Đổi transport ở cả hai service, restart Crawler, đợi readiness rồi restart
   dispatcher và mở admission. Quay lại HTTP cũng áp dụng đủ các bước trên.

## Runnable checks

Java dùng Testcontainers tự provision broker riêng:

```powershell
cd backend
.\mvnw.cmd '-Dtest=ScanCommandTransportPropertiesTest,CrawlerCommandDispatcherTest,CommandDispatchExecutorTest' '-Dit.test=RabbitScanCommandPublisherIT,DispatchCrashRecoveryIT' verify
```

Go integration cần broker demo và PostgreSQL **test riêng**, không dùng database
production. Test tạo/xóa random vhost và schema; tài khoản test cần quyền này:

```powershell
$env:WEBLENS_TEST_RABBITMQ_URL='amqp://weblens_admin:weblens-admin-local-only@127.0.0.1:5672/weblens'
$env:WEBLENS_TEST_RABBITMQ_MANAGEMENT_URL='http://127.0.0.1:15672'
$env:WEBLENS_TEST_POSTGRES_URL='<URL PostgreSQL test riêng>'
cd crawler
go test ./...
go vet ./...
go test -race ./internal/commands ./internal/config ./internal/httpapi
```

`-race` cần C compiler; Windows thiếu compiler có thể chạy bằng Linux Go Docker
image với source mount read-only. CI chạy `go test -race ./...` với broker và
PostgreSQL riêng. Không đặt các URL credential vào log chia sẻ.
