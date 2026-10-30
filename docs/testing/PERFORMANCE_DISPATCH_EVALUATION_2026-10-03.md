# Đánh giá giao lệnh HTTP và RabbitMQ — 2026-10-03

## Kết luận hiện tại

Đã hoàn thành đối chiếu command của lượt 150 và thử nghiệm transport cục bộ.
HTTP song song giảm đáng kể thời gian giao một burst so với gửi tuần tự; RabbitMQ
có lợi ích thêm trong mẫu 500 tổng hợp. Chưa đo transport với handler/PostgreSQL
thật; chưa có cơ sở đưa RabbitMQ vào production hoặc công bố capacity 500 người.

## Production evidence được đọc

Run `worker64-150-runtime-v1-20261003T062608Z`, source deployed
`91f1d35e0944573af7904648908b58430dd56f4f`. Backend SHA256
`e4bbd656fbb16f3e4a123dcacdd531ab9d3115b3bfe73f5e92873c05578309bb`;
crawler SHA256 `7acd544fb1b1861192b462b975356397663fef71ce9e864b15c5ad3a7f52755e`.

Query read-only lúc 12:26:01 UTC chỉ đọc command/inbox của 150 website đã đo.
Statement timeout 30 giây, lock timeout 500 ms, default_transaction_read_only=on.
Không đọc/log credential hoặc message payload. Evidence mới nằm cạnh bằng chứng
gốc trong `tmp/load/phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z/`:

- `dispatch-db-proof.json`: 146 command DELIVERED, một delivery attempt mỗi lệnh,
  146 crawler inbox APPLIED, message/aggregate/version khớp.
- `dispatch-analysis.json`: đối chiếu owner, website, status và admission IDs với
  terminal evidence; lưu SHA256 của các file nguồn.
- `dispatch-db-proof.stderr.txt`: giữ stderr của query, không đổi manifest gốc.

| Khoảng thời gian | Median | p95 | Max |
| --- | --- | --- | --- |
| Control outbox created→delivered | 7,536 s | 19,970 s | 20,181 s |
| Control created→crawler accepted_at | 7,515 s | 19,887 s | 20,119 s |
| Control created→crawler inbox timestamp | 7,528 s | 19,933 s | 20,161 s |
| Crawler accepted_at→started_at | 1,917 s | 4,636 s | 5,218 s |

Chỉ hàng đầu là hai timestamp cùng phía Control. Các hàng cross-service chưa có
sai số đồng bộ clock được đo. accepted_at được lấy trước commit; inbox received_at
và processed_at dùng cùng timestamp gần insert, không có ý nghĩa tách thời gian
nhận mạng và xử lý. Không có claim-start trace nên chưa phân rã được outbox wait,
HTTP và DB. Dispatcher gửi tuần tự là ứng viên góp phần vào độ trễ, chưa chứng minh
là nguyên nhân duy nhất.

Bốn request timeout vẫn là thất bại; thiếu scan/command tại các lần đối chiếu đã
giữ. Đánh giá broker không giải thích hoặc sửa timeout ở public HTTPS admission.

## Thử nghiệm cục bộ

- Công cụ riêng: `tools/load/dispatch-evaluation`, Java 21.
- Client AMQP 5.25.0; RabbitMQ 4.2.0 trong container trên WSL Ubuntu.
- Image digest: `sha256:8b31dd492c1f97d48127326dd07519f8aa854b6e75cb7ebf76878daba1c57259`.
- Docker daemon cục bộ độc lập, storage driver vfs, không dùng daemon/service VPS.
  Listener AMQP chỉ bind loopback port 5679; Erlang dùng 4 scheduler cho thử nghiệm.
- Bên nhận là cùng một Java sink với inbox trong RAM, sleep 20 ms mỗi command.
  Đây là mô phỏng thời gian xử lý, không phải handler hoặc PostgreSQL production.
- HTTP/1.1 dùng JDK HttpURLConnection và server loopback. RabbitMQ dùng queue quorum
  durable, message persistent, mandatory return, confirms theo lô 25 và timeout 5s.
- HTTP song song có 4 sender; RabbitMQ có 4 consumer, mỗi consumer prefetch=1.
  Mỗi lần phát burst 150, 300 hoặc 500 command độc lập; mỗi nhóm đo ba lần, luân
  phiên thứ tự các mode sau warmup 12 command/mode.
- Đo từ đầu burst đến lúc từng command được sink áp dụng, trước acknowledgment.
  Kiểm tra đủ identity và lỗi; RabbitMQ đợi acknowledgment hoàn tất trước closeout.
  Publisher-confirm time được ghi riêng, không dùng làm consumer-completion time.

### Kết quả

Các ô là **trung vị của p95 ba lần chạy**, không phải p95 của toàn bộ mẫu gộp.

| Số command tổng hợp | HTTP tuần tự | HTTP 4 sender | RabbitMQ 4 consumer |
| --- | --- | --- | --- |
| 150 | 6,614 s | 1,671 s | 1,286 s |
| 300 | 13,264 s | 3,342 s | 3,242 s |
| 500 | 22,098 s | 5,549 s | 4,232 s |

27 mẫu đo, tổng 8.550 command, tất cả được sink áp dụng, không có lỗi transport
trong các mẫu. Mẫu 500: HTTP 4 sender giảm p95 khoảng 74,9% so với tuần tự;
RabbitMQ giảm thêm khoảng 23,7% so với HTTP 4 sender. RabbitMQ mẫu 300 dao động
p95 2,531–3,617 s, một lần chậm hơn HTTP 4 sender. Không suy rộng các tỷ lệ này
sang workload production.

Ở 500 command, trung vị thời gian RabbitMQ publisher nhận đủ confirms khoảng
0,365 s, trong khi bên nhận áp dụng hết khoảng 4,448 s. Khoảng chênh này thể hiện
hàng đợi broker; không coi thời gian publish nhanh là hoàn tất công việc nhanh.

Raw results: `tmp/load/dispatch-evaluation-results.json`; summary có SHA256 nguồn:
`tmp/load/dispatch-evaluation-summary.json`.

Manifest thử nghiệm và cleanup: `tmp/load/dispatch-evaluation-proof.json`. Source
công cụ, raw results và summary có SHA256. Binary benchmark ban đầu được ghi hash;
hai mode restart-probe được bổ sung sau benchmark, không đổi thuật toán transport.

Chuẩn bị môi trường có lỗi được giữ riêng: invocation SSH đầu không khởi chạy,
command-line quá dài được sửa bằng truyền script qua stdin; không có SQL thành
công ở các invocation này. Daemon local ban đầu không sẵn sàng; container RabbitMQ
khởi động đầu báo cookie eacces. Container thử nghiệm được tạo lại và cấu hình
Erlang 4 scheduler trước khi bắt đầu benchmark. Không dùng các lần chuẩn bị lỗi
để tuyên bố deployment thành công hay gộp chúng vào số lỗi API production.

### Kiểm tra lỗi và durability

Đã kiểm tra với broker thật:

1. Mandatory publish không có route: có basic.return dù publisher confirm thành công.
2. Consumer đóng channel sau khi cập nhật inbox mô phỏng nhưng chưa ack: broker giao lại.
3. Giao lại cùng identity/payload: inbox mô phỏng giữ một execution.
4. Cùng identity khác payload: từ chối và đối chiếu payload ở dead-letter queue.
5. Publish persistent command vào durable quorum queue, chờ confirm, restart thật
   container broker, nhận lại đúng command, ack và xóa queue thử nghiệm.

Mục 3–4 kiểm tra transport kết hợp inbox mô phỏng; không thay thế kiểm thử inbox
PostgreSQL thật. Restart là graceful container restart trên cùng disk và một node;
chưa kiểm tra power loss, mất node, network partition, DB rollback, hủy trước create,
version sai thứ tự hoặc publish mất confirmation. Chưa có runtime adapter.

## Tái chạy

Phân tích evidence đã lưu, không phát workload:

```powershell
node tools/load/dispatch-evaluation/analyze.mjs --self-test
node tools/load/dispatch-evaluation/analyze.mjs tmp/load/phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z tmp/load/phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z/dispatch-analysis.json
node tools/load/dispatch-evaluation/analyze.mjs --transport tmp/load/dispatch-evaluation-results.json tmp/load/dispatch-evaluation-summary.json
```

Với broker phát triển riêng ở loopback 5679, client guest/guest chỉ dùng cho
thử nghiệm cục bộ, chạy công cụ độc lập:

```powershell
mvn -B -q -f tools/load/dispatch-evaluation/pom.xml compile exec:java '-Dexec.args=C:/Users/HP/Desktop/Pet_project/tmp/load/dispatch-evaluation-results.json'
mvn -B -q -f tools/load/dispatch-evaluation/pom.xml exec:java '-Dexec.args=--restart-prepare'
# Restart broker phát triển riêng, giữ nguyên data volume; đợi listener sẵn sàng.
mvn -B -q -f tools/load/dispatch-evaluation/pom.xml exec:java '-Dexec.args=--restart-verify'
```

Không trỏ công cụ vào broker dùng chung. Công cụ cố định loopback, tự xóa queue
riêng sau benchmark; broker phát triển do người chạy quản lý.

## Công việc tiếp theo

[ADR-017](../adr/ADR-017-rabbitmq-command-transport-evaluation.md) là proposal cụ
thể cho adapter và điều kiện áp dụng. Bước tiếp theo là thử handler/DB thật cho
HTTP có giới hạn và RabbitMQ, bảo vệ lease, idempotency, cancellation và quyền
truy cập; sau đó mới xét rollout và mixed workload 150→300→500.

Chưa có production change, DDL, dependency runtime, scan mới hay chỉnh lỗi/SLO
của lượt 150. Manifest FAILED_ACCEPTANCE_CRITERIA và wrapper RECOVERY_UNVERIFIED
giữ nguyên. Private seed giữ; global recovery ngoài scope vẫn unknown.

Cleanup cục bộ xác minh lúc 12:55 UTC: container thử nghiệm đã stop/remove, daemon
riêng đã thoát, không còn Java evaluation process và listener 5679 trên Windows/WSL.
Giữ dữ liệu evidence và cache công cụ/image cục bộ để tái lập. Encoding check cho
hai báo cáo chính, báo cáo này và ADR-017 PASS; analyzer self-test/Node syntax và
Maven compile PASS. Worktree source production vẫn không có thay đổi.

## Điều cần hiểu trước khi chấp nhận code

- Broker confirm bảo đảm nhận message theo semantics queue, không bảo đảm execution
  đã commit; consumer ack là một bước độc lập.
- Delivery at-least-once yêu cầu inbox chống trùng và chống payload collision.
- Prefetch giới hạn message chưa ack, không thay giới hạn host hay DB connection.
- Song song và chọn transport có tác động khác nhau; phải so sánh cùng ngân sách worker.
- Inbox trong RAM của công cụ là mô hình thử nghiệm, không được dùng làm workflow runtime.
