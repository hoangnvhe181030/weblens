# Billing runtime và crash recovery — PostgreSQL 17

Ngày: 2026-10-13. Scope được người dùng duyệt: kiểm chứng foundation billing trên
PostgreSQL 17, Spring Boot/JPA/authentication thật, HTTP IPN và crash/retry. Không
thu phí scan, đổi event contract/schema, gọi VNPAY thật hoặc deploy production.

## Phạm vi kiểm chứng

`BillingRuntimeIT` khởi động ứng dụng thật trên loopback/random port, PostgreSQL
17.6 và Redis 7.4 trong Testcontainers riêng. Redis chỉ phục vụ auth đã có trong
dự án, không phải datastore billing mới. Không tắt security, giả JWT, dùng H2 hoặc
transaction tự rollback ở cấp test. Infrastructure thiếu phải làm test fail,
không skip. Catalog/merchant/signing key là fixture, không dùng secret người dùng.

Mười test runtime:

1. V1–V14 migration, Hibernate validate, transaction manager thật là
   `JpaTransactionManager` dùng cùng DataSource với JDBC.
2. Đăng ký/JWT/session ledger + Redis thật; HTTP tạo đơn/replay/conflict,
   owner isolation, server-priced catalog và no-store. 24 IPN requests qua pool
   8 worker chỉ một `00`, 23 `02`, một ledger TOPUP; signature sai `97`, duplicate
   parameter `99`, amount mismatch `04`, unknown order `01`. JWT stale trên IPN
   không chặn provider; PAID replay không cấp checkout URL nữa.
3. Logout thật thu hồi quyền đọc/tạo đơn billing; không phát sinh order.
4. JPA persist user + flush/clear và JDBC order/account trong cùng transaction:
   commit cùng tồn tại, rollback cùng biến mất khi đọc lại ngoài transaction.
5. JPA persist scan + flush/clear và JDBC usage hold: rollback không để orphan
   scan/reservation/ledger; commit bảo toàn account và ledger. Đây là caller test,
   không wire vào ScanService/event hoặc cho phép thu phí clone.
6. Khóa account bằng connection độc lập: HTTP IPN `99` sau lock budget khoảng
   4 giây, PENDING/zero credit/zero ledger; mở khóa rồi retry cộng một lần.
7. Terminate đúng PostgreSQL backend connection của transaction test trong
   `beforeCommit`, sau khi account/ledger/order đã được ghi: commit không thành
   công, HTTP `99`, không ghi dở; retry qua connection mới cộng đúng một lần.
8. Facade từ chối outer transaction, không ack uncommitted IPN hoặc tạo checkout
   trước outer commit. Không tạo order/credit/ledger ngoài ý muốn.
9. Kill JVM con sau payment SQL nhưng trước commit; request chưa nhận response,
   connection đóng nên PostgreSQL rollback. JVM mới nhận cùng signed IPN trả
   `00`, replay sau đó `02`; cuối cùng chỉ một TOPUP.
10. Kill JVM con sau durable commit nhưng trước HTTP ack; dữ liệu đã PAID và có
    một TOPUP khi request vẫn đang chờ. JVM mới nhận cùng IPN trả `02`, không
    cộng lần thứ hai.

Crash probe chỉ nằm trong `src/test`: subclass repository gọi SQL thật, rồi pause
trước commit hoặc trong transaction synchronization `afterCommit`. Không thêm
fault switch vào runtime production. Parent chỉ dừng Process do test tạo, không
kill JVM khác/database service/Docker engine. Marker/latch có deadline; child bị
dừng trước khi đóng reader/client để timeout không làm treo cleanup.

## Finding và thay đổi tối thiểu

**Rủi ro hợp đồng nội bộ, không phải incident production đã xác nhận:**
`PaymentApplicationService` ban đầu không có transaction annotation. HTTP caller
hiện có không mở outer transaction nên các HTTP/crash test đã đúng; nhưng caller
tương lai có thể gọi facade từ transaction khác. `PaymentTransactionService`
dùng REQUIRED sẽ tham gia outer transaction, không commit trước khi trả về facade.
Vì vậy “facade không tự mở transaction” chưa đủ để bảo đảm ack sau commit.

Evidence: runtime regression test yêu cầu facade từ chối outer transaction bị
fail trước fix; chín test còn lại pass, gồm HTTP/JWT và hai JVM kill/restart.
Fix: `@Transactional(propagation = Propagation.NEVER)` trên facade. Spring proxy
từ chối ngay trước method body khi caller có transaction, không trả success hoặc
suspend outer transaction để che lỗi phối hợp. JDBC transaction service vẫn giữ
REQUIRED để có thể phối hợp atomically với JPA trong các caller nội bộ phù hợp.

Guard phụ thuộc lời gọi qua Spring bean/proxy, không áp dụng cho object được
`new` thủ công hoặc self-invocation; không tạo facade bằng tay trong runtime.
Không thêm dependency, migration, entity hoặc thay đổi architecture boundary.

Lỗi dựng test ban đầu: Spring tự nạp nested CrashConfiguration vào parent context
nên thiếu `BILLING_TEST_POINT`. Đã chỉ định `classes=WebLensApplication.class` cho
parent; crash configuration chỉ được import explicit trong JVM con. Không tắt
validation, security hoặc auto-configuration để làm test pass.

## Lệnh và kết quả

Docker được khởi động bình thường bằng `docker desktop start --detach --timeout 40`.
Không reset/sửa Docker, xóa volume hoặc gửi lệnh sửa/xóa/dừng container của người dùng.

```powershell
cd C:/Users/HP/Desktop/Pet_project/backend
mvn '-Dtest=BillingPersistenceIT' test
mvn '-Dtest=BillingRuntimeIT' test
# Final regression/build theo Maven lifecycle chuẩn:
mvn '-Dit.test=BillingRuntimeIT,BillingPersistenceIT' verify
```

- PostgreSQL17 persistence run: **12 pass**, 0 failure/error/skipped, tổng
  27,191 giây, kết thúc 15:30:43 UTC+7. V1–V14 từ database trống được áp dụng;
  lock timeout order/account 4064/4025 ms; không còn cảnh báo Flyway về PG18.
- Runtime sau guard: **10 pass**, 0 failure/error/skipped, tổng 1 phút 47 giây,
  kết thúc 15:40:28 UTC+7. Hai marker JVM crash BEFORE_COMMIT/AFTER_COMMIT ghi nhận
  final_topups=1. Final verify chạy lại cả checkout outer guard và cleanup context.
- Final `mvn -Dit.test=BillingRuntimeIT,BillingPersistenceIT verify`: **177 unit
  test + 22 billing integration test pass**, 0 failure/error/skipped. BUILD SUCCESS,
  tổng 2 phút 49 giây, kết thúc 15:45:42 UTC+7; build/repackage Spring Boot JAR
  thành công. Runtime final 10 test trong 89,58 giây, persistence 12 trong 24,19
  giây. Guard IPN/checkout và cleanup context đã được chạy trong final lifecycle.
- UTF-8 ba báo cáo billing pass; không trailing whitespace trong hai file Java
  và runtime report. Các thay đổi dirty trước đó giữ nguyên, không commit/push/deploy.
- Testcontainers tự dọn PostgreSQL/Redis test. Đã kiểm tra không còn JVM con
  BillingRuntimeIT; hai container người dùng vẫn chạy. Không dừng Docker engine.

## Giới hạn bằng chứng và production gate

- Chạy trên PostgreSQL 17.6 Linux container, không phải cluster PostgreSQL 17
  Windows/VPS đang vận hành. Cùng major không chứng minh cùng patch/HBA/storage,
  quyền runtime, latency hoặc migration lock window của production.
- Kill JVM và terminate transaction connection không phải power-loss, WAL/disk
  corruption, database failover hoặc kill đúng khoảnh khắc COMMIT tới server.
  Chứng minh hai biên known rollback/known commit; ambiguous commit vẫn cần
  durable order lookup/IPN replay và provider reconciliation, không suy failure.
- Fixture signer không phải VNPAY SIT. HTTP dùng loopback để kiểm tra servlet,
  không kiểm TLS/Caddy/trusted proxy/public IPN registration.
- Không có B0/B1/B2, large history seed hoặc p95/p99 mới. 24 requests/8 worker
  và 200 submissions/32 worker là correctness, không capacity benchmark.
- Database unavailable ở phạm vi hiện tại là lock timeout và connection chết
  tại commit. Chưa có soak network outage/pool saturation hoặc PostgreSQL restart.
- Chỉ chạy full unit suite và hai billing IT trong final verify, không claim
  toàn bộ integration suite của các module khác đã pass trong đợt này.
- Chưa có provider query/reconciliation, scan billing evidence, frontend/SIT,
  refund/live/retention/backup restore drill. Billing mặc định tắt; không production.

## Bước tiếp theo

Contract versioned `publishedBillablePages`, explicit scan origin và terminal
reason phải được review trước khi wire reserve/settle. Test 2xx HTML/3xx/non-HTML,
truncation, publish failure, fencing/replay, cancel-vs-complete và clone miễn phí.
Nếu cần đổi schema Crawler RED, phải bổ sung workload/queries/consistency/retention
và qua DESIGN_GATES riêng. Sau đó mới reconciliation, SIT, load và production gate.

## What the developer should understand before accepting this code

- JPA và JdbcClient chia sẻ local transaction khi dùng cùng DataSource qua
  JpaTransactionManager. Flush trước JDBC FK/read, clear trước kiểm tra JPA để
  không nhầm persistence-context cache với dữ liệu bền vững.
- REQUIRED tham gia transaction có sẵn; method return không đồng nghĩa commit.
  NEVER trên facade giữ ack/checkout ngoài transaction; proxy là phần hợp đồng.
- AfterCommit có thể đã ghi tiền dù HTTP chưa trả lời. Retry phải dùng cùng
  identity, kiểm durable order/ledger và không tạo topup mới.
- Crash test phải quan sát state từ connection khác, rồi kill/restart thật;
  throw exception hoặc new service trong cùng JVM không thay thế được phép thử này.

Ponytail giữ thay đổi runtime ở một transaction guard và test-only probe.
Spring Testing dùng runtime thật/flush-clear thay mock ở biên tiền và auth;
Encoding Guard kiểm tra UTF-8 báo cáo trước bàn giao.
