# RabbitMQ scan command transport — local validation 2026-10-15

Scope: [TASK-020](../../tasks/TASK-020-rabbitmq-scan-command-transport.md),
[ADR-017 revision 2](../adr/ADR-017-rabbitmq-command-transport-evaluation.md).

## Changes

- Backend chọn HTTP/RabbitMQ ở dispatcher hiện hữu; AMQP client theo Spring Boot BOM.
- Go consumer dùng client `amqp091-go`, kiểm tra JSON/identity và gọi Store hiện hữu.
- ACK sau commit, bounded acceptance retry và confirmed dead handoff.
- Topology/ACL local bằng Compose profile; CI có broker thật và race integration.
- Không đổi schema hoặc boundary của ba deployable.

## Evidence

Môi trường: Windows, Java 21, Spring Boot 3.5.16, Go 1.27.1,
RabbitMQ 4.3.6, PostgreSQL 17.6. Test DB/schema/vhost tách biệt, không dùng
production. Go race chạy Linux Docker image `golang:1.27.1` vì Windows không có
C compiler.

| Check | Kết quả |
| --- | --- |
| Backend compile/package qua Maven verify | PASS |
| Toàn bộ Java unit suite | 204 tests, 0 failures/errors/skips |
| `RabbitScanCommandPublisherIT` | 5 tests, 0 failures/errors/skips |
| `DispatchCrashRecoveryIT` hiện hữu | 2 tests, 0 failures/errors/skips |
| `go test ./...` với RabbitMQ/PostgreSQL test | PASS |
| `go vet ./...` | PASS |
| `go test -race ./internal/commands ./internal/config ./internal/httpapi` | PASS |
| Compose profile config | PASS |
| Diff whitespace và UTF-8 touched files | PASS |

Java IT kiểm tra persistent identity, message tồn tại sau broker stop/start,
publisher reconnect, mandatory unroutable, payload lớn, queue rejection/recovery,
producer không có quyền consume và dispatcher complete/retry đúng kết quả broker.
Repository dispatcher fixture dùng mock; broker là thật. Crash recovery hiện hữu
dùng PostgreSQL thật và durable HTTP receiver fixture, không phải Rabbit consumer.

Go integration dùng RabbitMQ và Store PostgreSQL thật, gồm 6 subcase:

1. Duplicate chỉ tạo một execution; collision giữ trong dead queue.
2. Cancellation đến trước create retry rồi commit trạng thái cancelled.
3. Lỗi acceptance DB được inject hai lần rồi phục hồi, không mất execution.
4. Retry đã hết và malformed JSON được giữ nguyên body/ID trong dead queue.
5. Shutdown sau commit trước ACK: restart nhận duplicate và vẫn một execution.
6. Dead binding thiếu: không ACK bản gốc, reconnect và chuyển dead thành công
   sau khi khôi phục binding.

## Limits / remaining production gates

Đây là kiểm thử adapter và acceptance, không phải full browser/API E2E hoặc
benchmark Java→Go cùng workload thật. Chưa đo throughput/p95 của Rabbit runtime,
mixed API+scan, broker nhiều node, mất volume, mất confirm qua network partition,
TLS với certificate production hoặc toàn bộ Java integration suite. Các suite
khác vẫn thuộc `clean verify` trên CI; không coi kết quả local là CI đã chạy.
Không deploy VPS hay tự chuyển transport của môi trường hiện hữu.

Production cần qua gate ADR-017, provision credentials/TLS/HA và đối chiếu
outbox/inbox/queue trước cutover. Broker confirm không phải consumer commit;
duplicate và dead queue là trách nhiệm vận hành đã được mô tả trong
[runbook](../../infra/rabbitmq/README.md).
