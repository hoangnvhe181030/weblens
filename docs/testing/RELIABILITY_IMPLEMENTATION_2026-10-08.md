# Reliability implementation — 2026-10-08

Trạng thái: triển khai và kiểm thử cục bộ. Chưa deploy, chưa chạy tải production,
chưa chứng minh toàn bộ roadmap production-ready. Không thêm dependency, service,
schema, index hoặc migration. Giữ ba deployable và datastore ownership hiện có.
Các thay đổi đã có trong workspace trước phiên này được giữ nguyên.

## 1. Phạm vi đã triển khai

| Nhóm | Thay đổi | Tác động tới Java Control Plane |
| --- | --- | --- |
| Dispatch | Sender hữu hạn 4 crawler / 2 capture / 2 site-clone; claim một message trong slot thực thi, không claim batch rồi xếp hàng cục bộ; mỗi drain tối đa 25 lần | Scheduled thread không chờ HTTP; số sender vẫn hữu hạn; mỗi claim có identity mới |
| Ordering/fencing | Chặn message sau của cùng aggregate đến khi predecessor DELIVERED; ACK/retry kiểm tra owner, attempt và lease sau row-lock wait; transaction claim/ACK/retry có timeout 5s; availability/lease/retry dùng DB clock | Thêm truy vấn predecessor và một row lock trong transaction ACK/retry; lease validation tính cả claim/ACK budget; không để JVM clock quyết định expiry/cooldown; cần đo DB cost trước rollout |
| Report protection | Tối đa 8 report call đồng thời mỗi instance, fail-fast 503; ownership check trước acquire, transaction kết thúc trước HTTP | Bảo vệ servlet/downstream; không phải giới hạn toàn cluster, không thay thế kiểm soát ingress |
| Report contract | Scan được Control Plane chấp nhận nhưng crawler trả 404: 503 SCAN_REPORT_NOT_READY; page detail 404 giữ nguyên | Client phân biệt eventual readiness với tài nguyên không tồn tại |
| Analytics | Khôi phục batch receipt lookup và worker timing đã có trong release production được đối chiếu; thêm query_id | Không bỏ FINAL/dedup, full-scan summary hay owner scope |
| Attempt budget | Storage I/O và response body có deadline; heartbeat không chồng nhau; attempt có deadline độc lập; abort khi mất lease/shutdown | Tránh worker giữ slot/lease vô hạn vì external I/O; không đổi command/event contract |
| Lease expiry | Crawler và Capture/Site publication kiểm tra expiry cả trước reclaim; kiểm tra lại tại bước ghi cuối | Kết quả muộn bị loại bỏ; retry vẫn dựa durable state và generation |
| Shutdown | Crawler join background components trước đóng store; Capture abort attempt/storage/browser | Không cam kết exactly-once; lease/replay là cơ chế phục hồi sau kill |
| Observability | Admission entry/exit có correlation, HTTP timing; report-stage percentiles; metrics endpoint cần service token; crawler slow query_id | Không log token/body, không đưa owner/URL vào metric label |
| Evidence | CI Go race; Java CI clean verify và bắt buộc critical IT chạy không skip; release từ chối dirty/wrong commit; hash component | Không coi public source SHA là đủ chứng minh binary provenance |
| Load harness | Login setup được pacing theo policy; admission mặc định vẫn burst/5s/1 POST; probe warm connection và stagger là workload riêng | Không bỏ rate limit, không replay admission tự động, không so workload đã đổi như benchmark tương đương |

## 2. Bằng chứng kiểm thử

Baseline workspace: Java 94 unit test pass; Capture 52 pass/9 skip; Go unit pass
nhưng integration thiếu cấu hình nên skip. Baseline này không đại diện production.

Sau thay đổi:

- Java final-source `mvn -B clean verify`: 102 unit test và 42 integration test
  pass, 0 fail, 0 skip, 0 flake; BUILD SUCCESS lúc 17:44:16 +07:00.
  Critical integration evidence gate pass trên XML của clean build này.
- PostgreSQL integration dùng migrations hiện hữu: concurrent disjoint claim,
  expired ACK/retry, stale attempt cùng owner, DEAD cooldown, scope,
  create/cancel ordering và expiry trong lúc chờ row lock.
- Vòng bổ sung phát hiện DEAD-retry test thất bại tại ranh giới DB/JVM clock;
  implementation từng trộn hai clock cho eligibility/expiry. Chuyển scheduling
  và lease sang DB clock, giữ occurredAt là event metadata; thêm regression test
  JVM clock năm 1970/2099. Không coi đây là bằng chứng root cause timeout production.
- Capture: 65 test, 59 pass, 6 browser smoke skip, 0 fail. PostgreSQL/MinIO
  integration chạy riêng: 3 pass, 0 skip. Typecheck/build pass.
- Test heartbeat ban đầu flaky do ngủ cố định khi máy bận; đổi sang chờ abort event
  và chạy lại toàn bộ suite thành công, không tăng runtime timeout để che lỗi.
- Crawler final-source: Linux `go test -race -count=1`, `go vet` và build pass,
  có PostgreSQL + ClickHouse thật cho integration; 8 package test pass,
  command/migrations không có test riêng.
- Offline load smoke và integration evidence gate self-test pass.
- Release script parse pass; dirty checkout bị từ chối trước staging/download.
  Chưa chạy packaging/download/browser smoke thực tế.
- Các container PostgreSQL/ClickHouse/MinIO và network riêng của phiên kiểm thử
  đã được dọn; dữ liệu fixture tạm bị loại bỏ, không có volume/dữ liệu người dùng.

### Benchmark dispatch cục bộ

Test dùng dispatcher thật + HTTP server local, 50 command mỗi lượt, receiver
ngủ 20ms, 3 lượt mỗi cấu hình; repository mock. `p95` bên dưới là thời gian
từ đầu lượt đo đến ACK thứ 95%, **không phải latency HTTP từng request hay API p95**.
Setup/JVM warmup và polling nằm trong số đo; không có DB contention/WAN.

| Lượt | 1 sender p95 / tổng (ms) | 4 sender p95 / tổng (ms) |
| --- | --- | --- |
| 1 | 2790.070 / 2880.032 | 638.299 / 654.202 |
| 2 | 2395.578 / 2499.524 | 575.746 / 617.370 |
| 3 | 2256.547 / 2350.505 | 602.527 / 618.596 |

Tất cả lượt: 50/50 ACK, unique Idempotency-Key, correlation/service header hợp lệ,
không retry. Đây là so sánh 1/4 sender trong implementation mới, **không phải replay
nguyên trạng legacy batch-25**. Chưa đo throughput DB hay cải thiện production.

File chính: backend messaging executor/ba dispatcher/repository và các test;
ScanReportService/CrawlerReportClient/CorrelationIdFilter/security metrics filter,
application.yml; crawler analytics receipt/report/worker, postgres store và main;
capture lease-attempt/storage/database/site-database/browser-session/capture và
worker loops; load k6 scripts/smoke, CI workflow, release packaging và integration
evidence gate. Không chỉnh frontend hoặc applied migrations trong đợt này.

## 3. Admission timeout: probe và tiêu chí kết luận

Bằng chứng cũ: run150 chỉ 146/150 accepted, 4 timeout 5s; Caddy ghi 146 POST 202,
handler tối đa khoảng 502.83ms, connection/TLS cao. Root cause chưa xác định:
không đủ bằng chứng quy timeout thành transaction, DNS, TLS hoặc socket backlog.

Chạy từng cell trên fixture riêng, level ID riêng, không reuse active scan; lưu
source SHA + component hashes + runtime config + DB size + generator/target CPU
và logs cùng cửa sổ. Giữ timeout 5s và một POST cho mỗi key.

| Cell | WEBLENS_ADMISSION_WARM_CONNECTION | WEBLENS_ADMISSION_STAGGER_MS | Ý nghĩa |
| --- | --- | --- | --- |
| A | 0 | 0 | Burst/cold baseline mặc định |
| B | 1 | 0 | GET health ngay trước POST từng VU; đo ảnh hưởng setup/reuse |
| C | 0 | 20 | Arrival rate khác, tách sức ép burst; không gọi là tối ưu latency |
| D | 1 | 20 | Control bổ sung nếu B/C khác rõ rệt |

Warm GET không bảo đảm socket reuse nếu server đóng kết nối; kiểm chứng
`connecting/tls_handshaking` của POST. Thêm GET tự nó thay đổi workload.
Đo ít nhất 3 lượt/cell, ramp 25→50→150; 500 chỉ sau khi levels trước đạt gate.
Không chạy matrix production mà chưa có cửa sổ tải/containment được duyệt.

Đối chiếu từng correlation: generator elapsed/error/connect/TLS → Caddy →
`scan_admission_enter/exit` → transaction timing. Entry log bắt đầu tại servlet
filter, không bao gồm DNS/TCP/TLS hoặc thời gian trước servlet. Exit có
`completed=false` khi exception; status lúc đó có thể chưa là final error status.
Không có log không tự chứng minh request chưa tới nếu collector mất log.

AC: giải thích được tất cả timeout bằng trace hoặc ghi rõ UNKNOWN; tổng 150
attempt phải khớp accepted + failed; không duplicate execution. Mục tiêu admission
p95<1s, p99<2s, fail<1% theo harness hiện có, đồng thời báo riêng status0/elapsed.
Không nâng timeout để đạt gate.

## 4. API p95 và rollout

Baseline production cũ: API p95 1030.47ms, pages p95 1692.09ms, error
0.010765%; run này trước Redis auth rollout. Chưa có số sau thay đổi này.
Đo auth, authorization, remote, mapping, servlet, ClickHouse query_log riêng.
Query timing có query_id; pages và summary là query riêng, không cộng p95 của chúng.
Full-scan summary vẫn full scan và dedup vẫn giữ nguyên.

Paced auth setup không tương đương old burst-login workload. Ghi auth mode,
token age, relogin/429 và report503 vào báo cáo; không loại request lỗi khỏi SLO.
Bulkhead 8 mỗi JVM cần đo với số instance/downstream pool thực tế. Acceptance:
đạt SLO API đã chốt trong load plan, không tăng lỗi 503 để làm đẹp successful p95,
không tăng heap/connection/backlog vượt capacity; baseline/candidate cùng dataset,
filter/page size/auth mode/cache condition và ít nhất 3 lượt.

Rollout theo canary có thời hạn: 1 sender → 4 sender sau khi downstream/DB ổn;
đánh giá predecessor query bằng EXPLAIN trên volume thật. Dừng/rollback nếu
admission lỗi, outbox age/DEAD tăng liên tục, stale ACK tăng, API503/error-budget
hoặc tài nguyên vượt gate. Không bật service mới, không thêm index tự động.

## 5. Failure/recovery runbook và phần còn lại

| Ưu tiên | Việc cần làm | Test / acceptance / bằng chứng trước-sau |
| --- | --- | --- |
| P0 | Admission matrix và baseline API sau Redis | Các gate mục 3–4; production root cause còn UNKNOWN đến khi có trace |
| P0 | Crash tại send→ACK, storage upload→COMMIT, ClickHouse receipt→PG ACK | Kill process trong môi trường staging; restart; một logical result, không mất command, không xóa object có thể đã COMMIT; lưu số replay/backlog/duration |
| P1 | Recovery query/index review theo DESIGN_GATES | Query/workload/cardinality/retention + EXPLAIN ANALYZE BUFFERS trên fixture; review trước DDL; so recovery time và write cost |
| P1 | Restore drill toàn hệ thống | Restore vào stack cách ly, kiểm row/hash/object/report/owner scope rồi reconciliation; đo RPO/RTO; TOC/hash backup chưa đủ |
| P1 | Release provenance end-to-end | CI clean checkout/build thành công, hashes khớp artifact và host runtime; script packaging riêng vẫn có thể lấy build output cũ |
| P2 | Alert/runbook ownership và soak | Backlog age, DEAD, lease stale, retries, timeout, API error-budget, DB/heap; không thêm observability datastore khi chưa có nhu cầu |

Khi xảy ra sự cố: ngừng thêm tải; giữ log/correlation/manifest; xác định datastore
owner và phase; kiểm durable state trước khi hành động. Không reset status/generation
bằng SQL, không truncate inbox/outbox, không retry POST với key mới để chữa timeout.
DEAD là cooldown/replay policy hiện hữu, không phải permanent quarantine.
Poison message có thể chặn aggregate sau nó: kiểm payload contract và scope, xử lý
bằng quy trình replay/cancel được review; không bypass predecessor ordering.

Lease expiry fence bảo vệ publication nhưng không biến hệ thống thành exactly-once.
Heartbeat single UPDATE còn cần test riêng cho lock-wait sát expiry; các datastore
ACK/retry khác chưa được đồng nhất hoàn toàn trong đợt này. Các bài test SQL
không thay thế kill-process/restore drill hay đo nhiều replica.
Java connect/read timeout là ngân sách của HTTP client, không phải bằng chứng
absolute wall-clock deadline trong mọi tình huống slow-drip/transport failure.
Database transaction timeout cũng không thay thế socket/network timeout.
Các fault case này phải được thêm vào staging acceptance trước khi tuyên bố
mọi dispatch attempt có hard deadline.

### Configuration mới

`WEBLENS_CRAWLER_DISPATCH_CONCURRENCY=4`,
`WEBLENS_CAPTURE_DISPATCH_CONCURRENCY=2` (capture và site clone),
`WEBLENS_CRAWLER_REPORT_CONCURRENCY=8` theo mapping trong application.yml;
`CAPTURE_STORAGE_TIMEOUT_MS=120000`, `CAPTURE_SITE_ASSEMBLY_TIMEOUT_MS=1800000`.
Page clone attempt hiện có hard budget 15 phút; capture attempt budget là browser
timeout + 120s. Kiểm tra workload lớn trước rollout; không tăng ngân sách để che
hung operation. Metrics chỉ dùng service token, không dùng bearer người dùng.

### Chạy lại kiểm tra

- Backend: `mvn -B clean verify` trong backend; sau đó chạy
  `tools/verify-backend-integration.ps1` từ repo root. Cần Docker cho PostgreSQL/Redis.
- Benchmark sender: `mvn -Dtest=CrawlerCommandDispatcherTest test` trong backend.
- Crawler Linux: cấu hình `WEBLENS_TEST_POSTGRES_URL`,
  `WEBLENS_TEST_CLICKHOUSE_ADDR/USERNAME/PASSWORD`; chạy
  `go test -race -count=1 ./...`, `go vet ./...` và build.
- Capture: cấu hình `CAPTURE_TEST_DATABASE_URL` và
  `CAPTURE_TEST_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET`; chạy npm test,
  test:integration, typecheck và build. Browser smoke cần runtime/flag riêng;
  các 6 smoke đã skip không được tính như browser verification.
- Harness offline: `node tools/load/k6-smoke-test.mjs`.
- Release: chỉ packaging sau CI clean checkout/build; không dùng workspace dirty
  này để phát hành. Không commit các thay đổi có sẵn chỉ để qua clean-check gate.

## What the developer should understand before accepting this code

- Transaction chỉ bao durable state: không giữ DB transaction trong lúc gọi HTTP.
- At-least-once delivery cần idempotency ở receiver; timeout HTTP có thể là thành công
  mà sender chưa thấy ACK. Retry giữ message identity.
- Lease không phải mutex vĩnh viễn: owner + attempt/generation + expiry fence loại
  worker cũ; row-lock wait có thể làm một lease hợp lệ trở thành hết hạn.
- Concurrency hữu hạn giới hạn tác hại, không tự tăng capacity. Ordering bảo vệ
  create/cancel cùng aggregate, còn aggregate khác có thể tiến triển độc lập.
- PostgreSQL→ClickHouse→object store là consistency protocol có replay/reconciliation,
  không phải một distributed transaction. Bằng chứng correctness và latency khác nhau.
- Local passing tests/synthetic benchmark không cho phép ghi CV rằng production p95
  đã giảm hay crash recovery đã được chứng minh.

## 6. Đợt tiếp theo — heartbeat lock-wait và kill JVM

Phạm vi: sửa race đã tái hiện, bổ sung kiểm thử crash cục bộ; không deploy,
không thêm dependency/service/schema/index/migration. Đợt này không xử lý hoặc
chứng minh root cause admission timeout production.

### Root cause đã tái hiện

Heartbeat `UPDATE ... WHERE lease_expires_at > clock_timestamp()` bắt đầu khi
lease còn hạn, sau đó chờ một transaction giữ row lock. Nếu transaction đó
rollback mà không đổi tuple, PostgreSQL không nhất thiết đánh giá lại predicate
đã đạt trước lúc chờ. Heartbeat có thể gia hạn lease đã hết hạn sau khi lấy khóa.

- Capture test trước sửa: renew trả true dù lease đã hết hạn, FAIL.
- Crawler test trước sửa: chờ host lock rồi heartbeat trả nil, FAIL.
- Capture/Site sửa bằng CTE `MATERIALIZED` lấy khóa trước, rồi mới đánh giá thời gian
  ở outer UPDATE. Cover capture, site ingestion, site page và site assembly.
- Crawler lấy page lock rồi host lock, sau đó kiểm tra cả hai expiry/generation;
  nếu một lease hết hạn thì rollback toàn heartbeat. Deadline gia hạn dùng DB clock.
  Giữ thứ tự page→host hiện có; không thêm khóa execution vào heartbeat.

Test giữ lock bằng SELECT FOR UPDATE, xác nhận heartbeat đang chờ bằng
pg_stat_activity, chờ DB clock vượt expiry rồi rollback blocker **không đổi row**.
Đây là regression thật của lock-wait, khác test chỉ đặt lease hết hạn trước call.
Healthy renewal, reclaim generation, stale publication và cancellation races vẫn
phải pass. Crawler có thêm hai round trip khóa mỗi heartbeat: chưa benchmark cost
ở nhiều nghìn active page; phải đo trước rollout, không tự thêm index.

### Crash/restart của Java sender

`DispatchCrashRecoveryIT` dùng PostgreSQL Testcontainers và dispatcher thật trong
JVM con, kill bằng destroyForcibly tại barrier rồi khởi động JVM mới. Không chỉnh
lease expiry/status bằng SQL để ép recovery; chờ lease 15s tự hết hạn.
HTTP receiver là durable dedup fixture trong DB test cô lập, **không phải crawler**.
Không có code crash hook ở runtime production.

| Điểm kill | HTTP request sau recovery | Receipt logic | Claim attempt | Thời gian lượt đo |
| --- | --- | --- | --- | --- |
| Claim đã commit, trước send | 1 | 1 | 2 | 19133.887ms |
| Receiver commit + HTTP202, trước local ACK | 2, cùng message/correlation/payload | 1 | 2 | 18885.305ms |

Hai test pass; outbox cuối DELIVERED. Thời gian gồm startup, lease wait và recovery,
không phải RTO production. Receipt hash được đối chiếu; service token vẫn bắt buộc.
CI evidence gate yêu cầu suite này không skip. Đây là bằng chứng kill-process của
sender với receiver fixture, **không** chứng minh kill full Spring Boot/crawler,
ClickHouse receipt→PG ACK, Capture upload→COMMIT hoặc restore toàn hệ thống.

### Kết quả đợt tiếp theo

- Capture vòng đầu sau sửa: 66 tests, 59 pass, 7 skip (6 browser + 1 MinIO chưa
  cấu hình), 0 fail; PostgreSQL có thật; typecheck/build pass. Storage code không
  đổi trong đợt này; MinIO đã pass đợt trước, không tính là được chạy lại ở đây.
- Java final-source full clean verify pass lúc 18:10:29 +07:00: 102 unit test +
  44 integration test, 0 fail/error/skip. Hai kill/restart test trong suite này
  đều pass; integration evidence gate pass trên XML mới.
- Go heartbeat regression hai lock path pass; full Linux race với PostgreSQL và
  ClickHouse, vet và build pass. Hai package tmp/reportprobe hiện hữu không có test.
- Capture integration riêng: 3 PostgreSQL test pass (bao gồm heartbeat 4 path),
  1 MinIO test skip vì không cấu hình ở đợt này.
- PostgreSQL/ClickHouse và network tạm riêng của đợt 2 đã được dọn sau test;
  không giữ volume, không tác động dữ liệu production.

File thay đổi đợt 2: capture-worker database.ts, site-database.ts và
database.integration.test.ts; crawler postgres store.go và store_integration_test.go;
test Java DispatchCrashRecoveryIT mới; integration evidence gate và báo cáo này.
Ponytail giữ phạm vi sửa đúng race đã tái hiện; Postgres/testing giúp test lock-wait
bằng engine thật, không dựa mock. UTF-8 check pass, không cần sửa encoding.

Phần còn lại: admission/API production matrix, heartbeat throughput/EXPLAIN trên
volume thật, kill các worker service với downstream thật, restore drill và
end-to-end release provenance. Các gate DESIGN_GATES và production vẫn giữ nguyên.
