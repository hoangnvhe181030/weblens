# Billing schema và IPN — execution revision 1

## Production rollout authorization — 2026-10-15

Yêu cầu mới của người dùng triển khai tất cả thay đổi lên VPS cho phép đưa V14
hiện hữu vào rollout này, sau khi xác minh các gate bên dưới trên host thật.
Không sửa SQL/checksum, không bật billing hoặc thanh toán LIVE. Ghi bằng chứng
backup, restore drill, lock window và Flyway trong báo cáo triển khai VPS.
Những ghi chú “production chưa được duyệt” bên dưới mô tả phạm vi ngày 13/10.

Scope đã duyệt: workload/policy revision 1 và `credit_accounts`, `payment_orders`,
`usage_reservations`, `credit_ledger`. Không sửa cấu trúc scans/users/websites,
không thêm datastore hoặc deployable. Triển khai giai đoạn này là local persistence
và sandbox API có feature flag; chưa kết nối thu phí scan, query/refund provider,
frontend hoặc production. Quyết định schema theo thứ tự DESIGN_GATES bên dưới.

Kiểm chứng runtime PostgreSQL17/HTTP/auth/JVM crash sau giai đoạn schema được
ghi riêng trong [runtime recovery report](../testing/BILLING_RUNTIME_RECOVERY_2026-10-13.md).
Kết quả bên dưới giữ lịch sử run PostgreSQL18 ban đầu, không phải trạng thái mới nhất.

## 8. So sánh phương án

Giữ phương án ledger + account projection + order + reservation từ hồ sơ đã duyệt.
Dùng JdbcClient đã có trong backend để biểu đạt conditional update/locking rõ;
không thêm JPA entity hoặc dependency cho bốn bảng. Không partition/Redis lock.

## 9. PK, FK và constraints

- Account PK owner UUID, FK users RESTRICT; balance >= held >= 0.
- Order PK UUID; reference UUID bỏ dấu gạch, unique trong scope provider,
  environment, merchant. Profile ID là version cấu hình immutable được pin;
  secret không lưu DB. Idempotency hash unique theo owner cho operation topup,
  fingerprint pin package request (không theo active profile có thể thay đổi).
- Order có amount integer minor units, currency, package/credits snapshot, times,
  PENDING/NOT_SUCCEEDED/PAID và provider transaction khi paid. NOT_SUCCEEDED vẫn
  unresolved, không bỏ late success. Unique transaction áp dụng PAID trong scope.
- Reservation PK scan UUID + scoped FK `(scan_id,owner_id)` tới unique scans đã
  có từ V5. MaxPages, price, policy immutable; RESERVED/FINALIZED cùng terminal
  evidence version/outcome/pages và charge/release bảo toàn reservation.
- Ledger bigint identity cho append locality; FK owner tới account; đúng một
  source payment hoặc reservation với composite FK owner ngăn ghi sai tenant.
  TOPUP: balanceDelta>0, heldDelta=0; RESERVE: balanceDelta=0, heldDelta>0;
  FINALIZE: balanceDelta<=0, heldDelta<0 và charge<=hold. Unique source/operation.
- Trigger chặn ledger UPDATE/DELETE/TRUNCATE; migration/database owner vẫn có
  quyền quản trị nên không thay thế least privilege và backup. Không purge.
- Times UTC timestamptz; bounded text, integer overflow fail/rollback. Không cascade
  xóa tài chính. Snapshot thay đổi phải dùng forward migration/operator review.

## 10. Index theo truy vấn

Account PK lookup O(log N); order owner+key unique cho replay, provider scope+
reference cho IPN; owner+createdAt+UUID cho history. Due unresolved order dùng
partial index (status != PAID), chưa có scheduler trong giai đoạn này.
Reservation PK scan + owner history + partial RESERVED createdAt.
Ledger owner+createdAt+identity keyset; unique payment TOPUP và reservation operation
đồng thời là source FK support. Không SUM history trên balance API.
Không thêm index trên bảng hiện hữu. EXPLAIN fixture được kiểm tra local sau migration;
chưa có capacity benchmark với 1m/3m rows hoặc skew như hồ sơ workload.

## 11. Transaction và locking

- Topup create: user lock hiện có để serialize cùng owner, idempotency lookup,
  snapshot/insert order và ensure account, commit. URL được dựng sau commit,
  không remote call; retry trả cùng order dù active profile/catalog đổi.
- Payment settlement: order row → account NO KEY UPDATE/atomic update → ledger.
  PAID replay phải cùng transaction/amount/currency/profile; conflict trả retry/error.
  Không gọi user lock sau account. Provider transaction conflict unique rollback
  toàn transaction, không một phần cộng balance.
- Usage foundation: caller transaction bắt buộc; scan row → reservation → account.
  Reserve kiểm maxPages khớp scan, status QUEUED, owner, pinned policy/price;
  thiếu credit rollback. Finalize chỉ dùng evidence version khớp terminal scan;
  method chưa có caller production vì publishedBillablePages chưa có contract.
- Dùng READ COMMITTED và row serialization/conditional SQL, không read balance
  rồi overwrite. Transaction database budget 5 giây; statement/lock timeout hữu hạn.
  Không tự retry giữa transaction. API key retry/IPN retry giữ identity; future
  reconciler retry 40001/40P01 toàn transaction, không ack khi commit lỗi.
- FK có thể lấy KEY SHARE ngầm; account lock dùng NO KEY UPDATE, không UPDATE
  để tránh upgrade deadlock khi nhiều source FK cùng owner. Kiểm concurrent test.

## 12. Workload benchmark và correctness

Local PostgreSQL thật: 200 IPN duplicate submissions / cùng order; 100 reserve
submission / cùng account chỉ đủ cho 10; parallel finalization/replay; rollback
sau khi đã ghi payment/usage; source owner mismatch/ledger immutability; late
success sau NOT_SUCCEEDED; cross-order provider transaction conflict; disabled API.
Check balance/held bằng SUM ledger sau commit từ connection mới, không cache JPA.
Đây là correctness/contended transaction tests, không 150-RPS capacity proof.
Benchmark 50/150 RPS, history volume, p95 trước/sau và production vẫn theo kế hoạch
trong hồ sơ workload, chưa chạy tự động vào provider/production.

## 13. Schema cuối cùng giai đoạn này và migration review

SQL source of truth: `backend/src/main/resources/db/migration/V14__create_billing_foundation.sql`.
Review quyết định: **safe with conditions cho database local cô lập; production
release chưa được duyệt**. Target PostgreSQL 17+; PG local đã cài 18.4, CI container
17.6. Flyway theo Spring Boot 3.5.16; migration transactional, không concurrent
index/nontransactional statement. Không backfill, không ALTER/DROP data cũ.

CREATE TABLE/index/trigger trên bảng mới; FK lấy lock trên users/scans dù không
rewrite data. Không hứa online/lock-free. Migration lock_timeout 5s,
statement_timeout 60s. Abort khi lock wait/statement timeout, không Flyway repair
checksum. Rollback giao dịch DDL nếu V14 lỗi; sau áp dụng giữ schema và disable
feature khi rollback app, không down migration xóa ledger. Trước production cần
exact PG/Flyway version, rows/traffic, lock window và restore drill xác minh lại.

## Runtime/config và giới hạn

`weblens.billing.enabled=false` mặc định. Chỉ SANDBOX trong release này; LIVE
configuration bị từ chối. Map profiles giữ adapter/key cũ; active profile chỉ
áp dụng order mới. Callback profile trong path phải khớp profile đã pin trong
order; không dùng default hiện tại để xử lý đơn cũ. Không đổi secret/merchant
trên profile ID có pending order; rotation tạo ID mới và giữ ID cũ đến khi đối soát.

API order/balance/history owner scoped. Chỉ VNPAY IPN GET anonymous với path chính
xác; các GET khác, POST vào IPN không được miễn authentication. Return URL không
có method settle. Checkout URL/IPN query phải no-store; proxy log không được ghi
query string. Client IP từ remoteAddr (không tin X-Forwarded-For tùy ý); khi deploy
proxy phải review trusted proxy và IP correctness trước SIT.

VNPAY IPN `00` sau commit, `02` same settled replay, `01` missing order, `04`
amount mismatch, `97` signature lỗi, `99` malformed/conflict/database/commit lỗi.
NOT_SUCCEEDED ghi nhận nhưng không cấp credit; vẫn nhận success đến muộn.
Late PAID được ghi nhận vì tiền đã vào provider; local expiry không làm mất tiền.
Không claim thiếu IPN tự hồi phục: query/reconciliation chưa triển khai.

Feature flag chỉ tắt API/service, **không tắt Flyway V14 khi khởi động app mới**.
Không đưa JAR này vào production như một thay đổi chỉ có flag trước khi migration
review/backup/restore/lock window được xác minh trên PostgreSQL 17 của VPS.

### Cấu hình sandbox ngoài repository

Mẫu sau chỉ là hướng dẫn, chưa tạo file cấu hình thật hoặc đăng ký merchant IPN.
Đặt YAML ngoài repository, giới hạn quyền đọc cho runtime; cung cấp secret qua
environment/operator secret store, không command line hoặc commit. Không bật
debug property binding, request-body/query-string/access logging cho payment.

```yaml
weblens:
  billing:
    enabled: true
    active-profile: sandbox-v1
    profiles:
      sandbox-v1:
        environment: SANDBOX
        merchant-account: ${VNPAY_SANDBOX_MERCHANT}
        hash-secret: ${VNPAY_SANDBOX_HASH_SECRET}
        checkout-endpoint: https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
        return-url: ${VNPAY_SANDBOX_RETURN_URL}
    packages:
      starter:
        amount-minor: 10000
        currency: VND
        credits: 1000
```

Giá 10.000 VND/1.000 credit chỉ là fixture, chưa phải bảng giá thương mại.
VND exponent 0, adapter chuyển amount wire thành 1.000.000. Chạy app bằng cấu hình
datasource local riêng, import YAML qua `spring.config.additional-location`.
Return URL HTTPS phải là trang thông báo do operator cấu hình; frontend chưa có
flow này. Return không được xác nhận thanh toán; client đọc order owner-scoped.
IPN HTTPS public cần đăng ký với VNPAY theo mẫu
`https://<public-host>/api/v1/billing/vnpay/sandbox-v1/ipn`; chưa thực hiện SIT.
Không gửi load synthetic vào endpoint VNPAY; dùng signer/simulator độc lập.

Đổi secret/merchant/provider: giữ profile cũ immutable, tạo profile mới cho order
mới và giữ adapter cũ đến khi đối soát hết đơn pending. Hiện chỉ có VNPAY adapter;
provider khác cần adapter/parser/API/config riêng, không sửa logic credit của
`PaymentTransactionService` vì service dùng `VerifiedPayment` chuẩn hóa. Không
claim chỉ đổi URL là có thể sử dụng gateway khác hoặc nhận tiền thật.

### API và file đã thay đổi

- `billing/config/BillingConfiguration.java`: external profiles/catalog, SANDBOX only.
- `billing/gateway/PaymentGateway.java`, `VnpayGateway.java`: protocol isolation/signature.
- `billing/dto/BillingResponses.java`, `billing/controller/PaymentController.java`:
  order/create/detail, balance, keyset ledger và IPN; amounts do server quyết định.
- `billing/repository/BillingRepository.java`, `billing/service/PaymentTransactionService.java`,
  `PaymentApplicationService.java`: atomic projection/ledger/order, commit trước ack.
- `billing/model/UsageBillingPolicy.java`, `billing/service/UsageReservationService.java`:
  reservation/finalize foundation, chưa có production caller.
- V14 là migration mới; `SecurityConfig.java` chỉ mở anonymous GET IPN chính xác
  và bỏ qua bearer trên endpoint này; `application.yml` thêm flag off mặc định.
- Tests trong `backend/src/test/java/com/weblens/billing/`; hai hồ sơ billing và
  entry phê duyệt trong DESIGN_GATES. Không nhận toàn bộ dirty diff làm thay đổi
  của billing; auth/Redis/crawler/capture/frontend đã có từ trước được giữ nguyên.

Usage foundation không thể tự phân biệt explicit scan với clone scan qua schema
hiện có: caller tương lai phải kiểm tra origin trước khi reserve. Không gọi service
cho clone/capture. Caller JPA tương lai phải flush scan trên cùng DataSource và
transaction trước JDBC reservation; không tạo transaction độc lập cho một scan
chưa commit. Nếu API/event wrapper có outer transaction, ack phải nằm ngoài
transaction đó: không dựa vào method return của nested REQUIRED để chứng minh commit.
Runtime review đã thêm NEVER trên PaymentApplicationService để từ chối outer
transaction, thay vì chỉ dựa vào convention. Transaction service vẫn giữ REQUIRED.

## Kết quả kiểm thử

Ngày 2026-10-13, Java 21.0.12.1 / Spring Boot 3.5.16:

- Full `mvn test`: **177 pass**, 0 failure/error/skipped, 50,291 giây,
  kết thúc 15:10:32 UTC+7. Có 72 unit/API/config billing test và 105 test backend
  khác, gồm architecture. Đây là run sau khi bổ sung API/config.
- Final `mvn package`: **177 pass** lần nữa và Spring Boot JAR được build thành
  công, 42,648 giây, kết thúc 15:17:17 UTC+7. Không chạy full Failsafe bằng package.
- `mvn -Dtest=BillingPersistenceIT test`: **12 pass**, 0 failure/error/skipped,
  36,233 giây, kết thúc 15:16:08 UTC+7. PostgreSQL 18.4 thật trong cluster test
  tạm, bind loopback:55438; không kết nối datasource production/local service cũ.
- V14 đã áp dụng trên database test mới; rerun validate đủ 14 migration và giữ
  checksum V14. Test dùng merchant/key fixture, không credential của người dùng.
- 200 duplicate IPN submissions trong pool **32 worker**: một `00`, 199 `02`,
  một TOPUP. 100 reserve submissions cùng owner: đúng 10 hold được chấp nhận
  khi balance chỉ đủ 10; 50 finalize cùng reservation chỉ một hiệu ứng.
- Signed IPN đi qua facade và transaction proxy thật: unknown order `01`, amount
  mismatch `04`, success `00` sau dữ liệu được đọc từ connection mới, replay `02`.
- Lock order/account bằng connection độc lập: callback `99` sau **4082/4041 ms**,
  không partial credit/ledger; nhả lock rồi retry `00`, duplicate `02`.
- Late success sau NOT_SUCCEEDED/expiry, profile/key replay, provider transaction
  reuse, owner isolation, append-only ledger, usage evidence/version mismatch,
  rollback sau writes và service recreation đều pass; projection khớp SUM ledger.
- EXPLAIN fixture nhỏ chọn `ix_payment_owner_history` cho owner/key lookup;
  còn filter key. Không ép planner hoặc gọi đây là volume benchmark; index unique
  owner/key vẫn có, cần seed/ANALYZE/EXPLAIN ANALYZE trên workload đã duyệt.
- Docker engine không sẵn sàng nên không chạy container PostgreSQL 17.6 hoặc
  full Failsafe suite. Flyway cảnh báo PG18.4 mới hơn phạm vi đã kiểm thử (tối đa
  PG17); cần rerun trên PG17 đúng production trước rollout. Không nâng dependency.
- Đã dừng cluster test loopback:55438 sau kiểm thử, giữ thư mục dữ liệu tạm để
  có thể kiểm tra lại; không xóa ledger hoặc tác động PostgreSQL service hiện có.

Các test rollback/service recreation không phải kill JVM/process/database trong
production. Không có B0/B1/B2, p95 trước/sau, SIT/browser E2E, provider query/refund,
reconciler, ledger volume/retention job hoặc proof capacity 100k/1k clients/150 RPS.
Chưa wire scan admission/event settlement hoặc đổi runtime production.

Lệnh kiểm thử:

```powershell
cd C:/Users/HP/Desktop/Pet_project/backend
mvn test
# Docker hoạt động: integration test tự tạo postgres:17.6-alpine.
mvn '-Dtest=BillingPersistenceIT' test
# Thay thế chỉ khi đã tạo database test riêng, loopback, user billing_test:
$env:WEBLENS_BILLING_TEST_JDBC_URL='jdbc:postgresql://127.0.0.1:55438/weblens_billing_test'
mvn '-Dtest=BillingPersistenceIT' test
Remove-Item Env:WEBLENS_BILLING_TEST_JDBC_URL
```

### Bước còn lại theo thứ tự

1. PostgreSQL17 runtime context (JPA transaction manager + auth thật), signed
   HTTP IPN smoke, process-kill/commit-boundary drill đã có bằng chứng trong runtime
   recovery report. Cần giữ test trong CI; chưa chứng minh môi trường VPS thật.
2. Contract versioned publishedBillablePages + explicit origin + terminal reason;
   test 3xx/non-HTML/truncation/publish failure, cancel/complete/out-of-order/replay.
   Review riêng nếu cần đổi schema Crawler RED; sau đó mới wire reserve/settle.
3. Provider query/reconciliation cho missing IPN/orphan hold: có durable evidence,
   bounded retry, giữ profile cũ, không suy failure từ timeout; metrics/alerts/runbook.
4. Frontend sandbox và VNPAY SIT với IPN HTTPS đã đăng ký, proxy/IP/log review.
5. B0/B1/B2 seed và controlled load theo hồ sơ revision 1; báo offered/achieved RPS,
   pool/lock wait, ledger invariant, p95/p99 và regression Java Control Plane.
6. Production/live readiness review, backup/restore và canary; giữ schema/ledger
   khi rollback, không purge hoặc down migration. Hiện runtime từ chối LIVE.

## What the developer should understand before accepting this code

- HMAC chỉ xác thực callback. Lock, unique source/transaction và transaction
  atomic bảo đảm hiệu ứng tài chính một lần khi request có thể gửi nhiều lần.
- `@Transactional` qua Spring proxy: commit có thể lỗi sau khi method body return.
  Facade không có outer transaction nên chỉ ack khi proxy đã commit; self-call
  hoặc nested caller có thể phá giả định này và phải được review.
- Conditional UPDATE giữ invariant balance >= held >= 0; không đọc số dư rồi
  overwrite. Hot owner vẫn bị serialize: tăng thread/pool không giải quyết lock wait.
- NO KEY UPDATE tương thích FK KEY SHARE, tránh một nguồn lock-upgrade deadlock;
  không bảo đảm toàn hệ thống miễn deadlock. Retry phải replay toàn transaction.
- Ledger append-only hỗ trợ audit/reconciliation, không thay least privilege,
  backup hoặc chứng minh projection đúng nếu operator trực tiếp sửa database.
- Không lấy succeededCount làm số trang tính phí. Hợp đồng evidence giữa Go/Java
  phải đáng tin cậy trước khi billing tác động đến admission và terminal handling.

Ponytail giữ JDBC/native crypto/dependencies hiện có và ba deployable. UTF-8
đã pass cho hai hồ sơ billing, DESIGN_GATES và application.yml; scoped diff check
không có whitespace error. Không commit/push/deploy hoặc dùng secret thật.
