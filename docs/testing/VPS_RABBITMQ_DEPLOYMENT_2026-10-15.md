# Triển khai RabbitMQ lên VPS — 2026-10-15

## Kết quả

**PASS chức năng trên VPS**, xác minh lúc 11:14 UTC+7 ngày 15/10/2026.
Người dùng yêu cầu triển khai tất cả thay đổi hiện tại lên VPS, bao gồm RabbitMQ.

- Website: https://jobnext.top.
- Active release: `8c29feffdf896fc84a9652bb0cc02313d68b5c26`.
- Source đã push lên `hoangptkd`, nhánh `codex/reliability-local-evidence-20261014`.
- ZIP Windows AMD64: 628.477.795 byte; SHA-256
  `5e3a36928a0afc429ad214acd868f7bede01d9db3af5aad1036ebb873922a6bd`.
- Giải nén trước cutover; xác minh đủ 7.246 checksum trong manifest trên VPS.
- Backend, Crawler, Capture, Caddy, PostgreSQL, Redis, RabbitMQ đều Running.
  Backend/Crawler/Capture health 200/UP; frontend HTTPS 200; anonymous `/api/v1/me` 401.
- Cấu hình production dùng RabbitMQ cho tạo/hủy scan; HTTP command route được
  xác thực trả 503. Event/report/Capture/Clone tiếp tục REST.

Đây là rollout trực tiếp qua SSH key đã có, khác với luồng GitHub release pull.
`WebLensDeployPoll` được **giữ Disabled**: GitHub deployment release mới nhất còn
là `6ade9332e2e4c4df12b304edecad5d756462143f`; bật lại ngay sẽ có nguy cơ downgrade.
Chỉ bật sau khi GitHub deployment release chứa bản đang chạy hoặc bản kế tiếp đã
được review/kiểm thử. Không force-push hoặc tự merge main để tránh vấn đề này.

## Backup và migration

Đánh giá V14: **safe with conditions** trên PostgreSQL **17.11**, Flyway **11.7.2**,
triển khai có maintenance window, không rolling app overlap. Không sửa SQL/checksum.

- Ba database được `pg_dump` custom-format, kiểm tra TOC và SHA-256:
  Control 256.064.385 byte, Crawler 715.495.938 byte, Capture 189.370 byte.
- Backup/env snapshot ở `C:\ProgramData\WebLens\backups\rabbitmq-rollout-20261015`,
  chỉ Administrators/SYSTEM được truy cập. Không đưa secret vào report/repository.
- Restore Control vào database cô lập trên cùng PostgreSQL17: 3.302 user,
  3.045 scan, 13 Flyway migration. V14 chạy trong transaction, 4 bảng mới và
  append-only trigger tồn tại, số user/scan giữ nguyên. Database thử đã drop.
- Trước cutover: không active scan, không scan command chưa DELIVERED, không
  transaction dài trên Control. Dừng public admission và Backend, kiểm tra lại.
- Flyway runtime validate đủ 14 migration, V14 áp dụng thành công trong 1,178 giây.
  Chỉ tạo bảng/index/trigger mới; FK vẫn lấy lock trên users/scans. Giữ lock timeout
  5 giây và statement timeout 60 giây; không khẳng định online/lock-free.
- Billing giữ `false`; không nhận thanh toán LIVE, không nối thu phí scan.
  Nếu rollback app, giữ schema additive V14; không xóa ledger hoặc Flyway repair.

## RabbitMQ và runtime

RabbitMQ **4.3.6**, Erlang **28.5**, Windows service `WebLensRabbitMQ` Automatic.
AMQP 5672, management 15672, distribution 25672, EPMD 4369 đều chỉ loopback.
Mỗi role có credential ngẫu nhiên riêng lưu ngoài repository. Management alarm
health đã kiểm tra bằng authentication. Hai durable quorum queue:
`weblens.scan.commands.v1`, `weblens.scan.dead.v1`.

Backend phụ thuộc Postgres/Redis/RabbitMQ; Crawler phụ thuộc Postgres/RabbitMQ.
Giữ nguyên database/cloud credential, ClickHouse HTTPS/read pool 24 và các setting
khác, trừ transport/billing flag và thay override browser `playwright` thành
`camoufox`. Camoufox 152.0.4-beta.28 có sẵn trong release và Windows smoke đạt.

Sửa lỗi triển khai được phát hiện thực tế:

1. Erlang service tự cung cấp `-home`; thêm lần nữa gây lỗi boot. Dùng APPDATA
   riêng có ACL và cookie tại đường dẫn OTP28 có thể đọc.
2. `management.load_definitions` treo trước khi definition-import worker pool sẵn
   sàng. Dùng core `definitions.import_backend=local_filesystem` và local path.
3. WMI network providers trên host bị treo: kiểm tra listener dùng .NET/native
   netstat, chỉ dừng Backend process tại đúng Java runtime và port của WebLens.
4. Đường dẫn giải nén cũ quá dài: native tar + staging ngắn. Lần thất bại đầu
   phục hồi bản cũ trước khi đổi transport. Lần cuối stage/checksum khi app còn chạy.
5. Capture raw migration checksum phụ thuộc LF/CRLF. SQL có cùng nội dung nhưng
   production dùng CRLF; `.gitattributes` cố định CRLF và ZIP đã khớp đúng 5 hash
   production. Không sửa checksum database.
6. Cấu hình browser lịch sử chọn Playwright nhưng local artifact chưa có Chromium.
   Capture smoke đầu FAILED; chuyển sang Camoufox đã pin và chạy lại đạt.

## Bằng chứng chức năng

Tài khoản rollout riêng, password ngẫu nhiên lưu private; chỉ crawl owned fixture
`https://jobnext.top/__weblens-load/page/999`. Fixture route bật tạm, sau test đã tắt.

| Kiểm tra | Kết quả |
| --- | --- |
| Scan `9f9d7394-9c8f-4fea-b914-08b1250ddad7` | COMPLETED, 1 trang, report fresh |
| Scan API accepted → terminal, một lần đo | 3.560 ms; không phải p95 |
| Capture `4c160e91-2109-4db6-8f2c-d7fb40099bbb` | COMPLETED; screenshot 27.034 byte; checksum/artifact đúng |
| Capture accepted → artifact, một lần đo | 71.006 ms; không phải p95 |
| Login → authenticated identity → refresh | PASS |
| Logout → dùng access token cũ | 401 |
| Scan hủy `6ba1164d-9bc9-42f1-9b53-826fd04cd61d` | CANCELLED |
| Outbox/inbox trong scope 2 scan | 3 command / 3 APPLIED inbox, cùng message/aggregate/version |
| Crawler execution | Đúng 2 execution cho 2 scan |
| Queue cuối test | 0 ready, 0 unacked, dead queue rỗng; 4 consumer |

Broker thống kê 4 publish/deliver/ACK, 0 redelivery trong toàn đợt smoke; gồm scan
của lần Capture thất bại trước khi đổi engine. Reconciliation cuối chỉ lấy 3
command của 2 scan thành công/hủy nêu trên. Không phát lại outbox DELIVERED.

## Kiểm thử build

- Backend full `clean verify`: 182 Surefire + 72 Failsafe, không fail/skip;
  evidence gate xác nhận đủ integration suite quan trọng, gồm RabbitMQ.
- Frontend: lint, 39 test, production build đạt; bundle không chứa API loopback.
- Capture: unit/typecheck/build đạt; PostgreSQL integration 3 pass sau khi cố định
  CRLF. MinIO integration 1 skip vì chưa có test credential; production smoke đã
  tải/xác minh screenshot và artifact. Windows Camoufox smoke đạt.
- Crawler Windows build đạt; Go test/vet và race checks xem báo cáo implementation.
- Windows cutover self-check đạt trên Windows PowerShell5: giữ setting/dependency,
  rollback byte environment, không dừng process chiếm port ngoài Java runtime đích.
- UTF-8 và diff check đạt. Không chỉnh migration đã áp dụng.

Evidence JSON sanitized ở local `tmp/rabbit-vps-evidence/` gồm backup manifest,
restore drill, artifact stage, deployment proof và final host proof. Bản gốc nằm
trong private backup directory trên VPS. Backup env/account không được tải về.

## Giới hạn và vận hành

- RabbitMQ một node không có HA. Chưa benchmark mixed workload 150/300/500;
  không chứng minh tăng throughput crawl hay production capacity.
- Dead queue cần operator đối chiếu; broker confirm không chứng minh Crawler commit.
- Auto deploy poll đang tắt để tránh downgrade; cần published release phù hợp
  trước khi bật lại bằng `schtasks /Change /TN WebLensDeployPoll /Enable`.
- Browser Capture vẫn chậm trong smoke đơn; chưa có kết luận regression/performance.
- Kiểm thử này không thay full browser UI/clone E2E, broker-node outage hoặc VPS
  reboot drill. Không chạy tải cao lên production trong đợt triển khai.

## What the developer should understand before accepting this code

Outbox lưu command trong transaction nghiệp vụ; publisher confirm chứng minh
bàn giao bền vững tới broker; ACK chỉ sau inbox/execution commit. Ba bước không
có distributed transaction nên duplicate vẫn có thể xảy ra; message ID ổn định,
dedup và version/fencing bảo vệ trạng thái. Queue rỗng cần đi cùng reconciliation.
Rollback transport phải dừng admission và giải quyết command còn trong broker;
không chỉ đổi flag. Binary rollback không gỡ V14 và không được xóa ledger.
