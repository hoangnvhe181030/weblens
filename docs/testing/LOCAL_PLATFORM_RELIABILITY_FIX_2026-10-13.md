# Local reliability fixes và benchmark lại — 2026-10-13

## Phạm vi

Tiếp nối [baseline](LOCAL_PLATFORM_LOAD_CLONE_2026-10-13.md). Chỉ sửa các lỗi
runtime đã xác nhận và kiểm chứng trên Docker local cô lập. Không deploy production,
nhận tiền thật, đổi schema/architecture hoặc tắt máy. Workspace dirty vẫn được giữ
nguyên ngoài phạm vi; artifact này không đủ điều kiện release.

## Kết luận

Ba lỗi correctness đã sửa và có regression: startup khi billing disabled,
SafeProxy HTTP header, public clone metadata/byte mapping. Clone local đóng gate
100/1.000 discovery + hai owner concurrent + PG/MinIO/GC. API balanced 50 RPS pass,
150 RPS fail error budget (29/9.000 `SCAN_REPORT_BUSY`); không chạy 500/soak.
Chưa đóng admission timeout production hoặc production full-workload readiness.

File runtime/test trong phạm vi: `BillingConfiguration`/test,
`SiteCloneReportClient`/test, `SiteCloneService`/test,
`capture-worker/src/safe-proxy.ts`/test. Harness/report: `local-platform-benchmark.mjs`,
self-test, `tools/load/README.md` và báo cáo này. Những file đó có thể chứa thay đổi
dirty từ trước: không coi toàn bộ diff với HEAD là bản sửa của đợt này.
Không thêm dependency, schema, migration hoặc service; không commit/push/deploy.

## Bản sửa và regression

- `BillingConfiguration.Properties` chịu cùng `ConditionalOnProperty` như module.
  Main property scanner không còn bind catalog khi billing tắt. Validation khi
  bật vẫn nguyên vẹn; LIVE vẫn bị từ chối. Test dùng scanner thật cho package
  billing và cấu hình test-only, không tự lọt vào component scan runtime.
- SafeProxy copy incoming headers, **delete** `proxy-connection`, rồi truyền Host
  đúng cho Node HTTP. Không đặt header thành `undefined`. DNS pinning, SSRF,
  timeout, transport budget và cleanup không bị nới.
- Test proxy dùng HTTP server loopback thật; chỉ transport destination được mock
  để không ra Internet. Public-address policy và Node header validation vẫn thật.
  Kiểm method/path/query/body, Host, response 200 và cả trường hợp có/không có
  `proxy-connection`. Full-stack riêng mới chứng minh đường mạng không mock.
- Harness bỏ profile/catalog giả khi billing tắt; bổ sung cumulative report timer
  và ClickHouse query metadata local (không query text/exception text/credential).
  Timer aggregate không phải per-request percentile; thiếu metadata phải được ghi
  unavailable, không suy root cause hoặc coi là pass.
- Full-stack phát hiện thêm lỗi contract: Worker gửi `archiveBytes`, Java decode
  trực tiếp thành public DTO chờ `totalArchiveBytes`, nên thành 0. Worker không sở
  hữu website hoặc timestamp accepted công khai. Java nay dùng nested WorkerReport
  và compose public response với metadata Control Plane; verify clone/scan ID trước
  khi trả dữ liệu. Không đổi worker wire contract hoặc database. Hai regression
  trước fix fail (0 byte và null website); sau fix pass, cùng test sai scan ID.

Trước fix: hai test billing disabled fail với binding exception; HTTP success
regression fail vì nhận 502/body rỗng. Sau fix: focused regression pass.

## Kiểm thử đã hoàn tất

- Maven `-Dit.test=BillingRuntimeIT,BillingPersistenceIT verify`: **178 unit +
  22 integration pass**, zero failure/error/skip; BUILD SUCCESS, 2 phút 49 giây,
  kết thúc 17:41:55 UTC+7. PostgreSQL 17.6/Redis thật, JPA/JDBC transaction,
  HTTP IPN và BEFORE_COMMIT/AFTER_COMMIT JVM crash/replay đều pass.
- Capture typecheck/build pass. Unit command: **58 pass, 10 skip** (6 browser
  smoke, 3 PostgreSQL integration, 1 MinIO integration thiếu cấu hình ở invocation
  đó). Không gọi các test skip là đã được kiểm chứng.
- Load harness/self-check cuối đợt: **11 pass, 0 skip** bằng `node --test`
  cho local-admission, local-platform, k6-smoke và smoke-test. Các mock preflight
  trong smoke không là production probe. Không thêm dependency hoặc migration.
- Build sau contract fix: **181 unit pass**, zero failure/error/skip, 43,428 giây,
  kết thúc 17:55:42 UTC+7. 22 billing IT phía trên chạy trước contract-only fix;
  không gọi package `-DskipITs` là đã chạy lại toàn integration suite.

## Benchmark mới

Lượt full-stack `42bc9fa4` sau billing/SafeProxy fix, trước metadata mapping fix:

| Scenario | Kết quả |
| --- | --- |
| Clone 100 URL | PUBLISHED, 10/10 representative, 0 failed, 12 archive entry; 65.098 ms |
| Clone 1.000 URL | PUBLISHED, 10/10 representative, 0 failed, 12 archive entry; 188.121 ms |
| Admission 25 owner | 25/25 accepted và durable receipt khớp; p95 193,2 ms/p99 258,6 ms |
| Mixed synchronized 50 RPS/60s | 3.001 iteration, 0 drop, 13 lỗi SCAN_REPORT_BUSY (0,433%); FAIL |

Mixed activity p95 57,712 ms/p99 157,702 ms; report p95 152,724 ms/p99 326,925 ms.
Các lỗi đều là 503 report capacity, không phải mất accepted scan hoặc timeout 5s.
Fail error budget nên không chạy 150/500/soak trong lượt đó. Clone pass là functional
archive pass ở gate cũ; metadata public sai đã được ghi nhận và kiểm lại ở lượt mới.

Java mặc định billing false không catalog khởi động health UP; probe anonymous IPN
khi disabled trả 404. 42 resource samples (10s): Hikari active max 1, pending/timeout
0, Tomcat busy max 9; Capture CPU peak 196,77%, ClickHouse 105,95%, Java 67,92%,
PG 23,44%; host free RAM min 4,80 GiB. Sample không loại trừ microburst/throttling.

### Bằng chứng sâu hơn về report

592 report request có 13 rejection, 579 remote calls. Cumulative authorization
timer 0,892s/592 call, remote 34,145s/579 call; đây là total/mean, không p95.
1.737 QueryFinish trong cửa sổ activity = 579 × 3 queries; zero exception code.
P95 server-query duration 30ms/p99 93ms, nearest-rank trên query **không phải**
API request. Ba slow query match được theo query_id:

| Query suffix | Operation | Crawler query/read ms | Admission wait ms | ClickHouse duration ms | Rows/bytes |
| --- | --- | ---: | ---: | ---: | --- |
| 7e1e3 | summary | 259,299 | 0,000291 | 258 | 1.184 / 71.459 |
| b47d | summary | 272,723 | 0,000231 | 271 | 1.184 / 71.459 |
| 4c63 | summary | 275,352 | 0,000270 | 274 | 1.184 / 71.459 |

Với **ba query này**, latency nằm chủ yếu trong server execution/wait được
ClickHouse ghi nhận, không trong semaphore admission Crawler hoặc client dial.
Không suy từ ba sample sang mọi request/production; chưa tách CPU scheduler,
throttling, merge và query pipeline. Read rows lớn hơn một leaf không tự chứng minh
owner filter sai: index granularity/physical block có thể gây read amplification.
Cần EXPLAIN/query-profile và cardinality đại diện trước query/schema tuning.

Không có matched before/after performance: JAR, fixture cardinality,
cache/JIT/workflow warmup khác baseline cũ. Không công bố tỷ lệ tăng throughput.

### Clone-only đã đóng gate local

Lượt `572afbca-994b-4a99-94ca-3a2fde41fe76`, kết thúc 18:12:22 UTC+7:
**PASS_CLONE_ONLY_LOCAL_ONLY**, source hash giữ nguyên trong experiment.

| Scenario | Discovery / packaged | Queue→verified archive | Tổng artifact bytes | Kết quả |
| --- | --- | ---: | ---: | --- |
| Smoke | 100 / 10 | 65.246 ms | 62.018 | PASS |
| Large discovery | 1.000 / 10 | 190.178 ms | 511.679 | PASS |
| Concurrent A | 100 / 10 | 74.977 ms | 62.020 | PASS |
| Concurrent B, owner độc lập | 100 / 10 | 121.462 ms | 62.020 | PASS |

Mỗi job có 12 archive entries, zero failed representative, hai artifact ZIP +
external manifest. Hash/byte-size/download headers, semantic/locale selection,
asset dedup, post-render JS và offline link đều được kiểm; metadata website/scan
khớp accepted request, timestamp giữ nguyên trong tolerance 1ms, total bytes
khớp cả ZIP lẫn manifest. Same-key replay trả cùng job/scan; wrong-owner bị 404.
Thời gian bảng gồm admission, chờ scan/dispatch, render, publish, polling và kiểm
download; không phải riêng render latency. Hai concurrent job có queue contention.
Không suy throughput trên nhiều job từ một cặp hoặc nói đã render 1.000 trang.

PostgreSQL/MinIO integration: **4 pass, 0 fail, 0 skip**, 9,699 giây. Bao phủ
duplicate command/analytical completion, phase retry, page lease fencing,
cancellation partial và GC; heartbeat kiểm lại expiry sau row-lock wait; MinIO
put/copy/integrity read/delete. Đây không phải process-kill clone recovery drill.
Inventory sau GC: đúng **8/8 published objects**, không còn staging/bundle object;
tám container/anonymous volume và hai network của run đã dọn. Evidence giữ lại.
40 mẫu tài nguyên mỗi 10s: Capture CPU peak 196,2% trong cap 2 CPU; Hikari active
max 2, pending/timeout 0; host free RAM min 4,52 GiB; không container nào OOMKilled.
Không dùng các sample thưa này để loại trừ queue wait hoặc CPU throttling ngắn.

### API-only lệch pha

Lượt `fe28cdf4` được đo độc lập trên stack mới, không clone warmup; 25 authenticated
owners, scan/report thật, 25 VU max, một GET/iteration và zero think time.
Admission 25: **25/25 accepted, durable scan/outbox khớp**, p95 493,6ms/p99 499,32ms.
Mỗi seed website là một leaf page, tổng 25 scan nhỏ; đây không phải cohort scan
1.000 trang. Các route đều có request và owner authorization thật.

| API phase | Activity requests | Error / drop | Activity p95 / p99 | Report p95 / p99 | Gate |
| --- | ---: | --- | --- | --- | --- |
| Balanced 50 RPS / 60s | 3.001 | 0 / 0 | 47,003 / 64,279ms | 58,331 / 90,458ms | PASS |
| Balanced 150 RPS / 60s | 9.000 | 29 (0,322%) / 0 | 78,639 / 216,679ms | 216,674 / 283,983ms | FAIL |
| 500 RPS / soak | Không chạy | Gate trước fail | — | — | NOT RUN |

Cả 29 lỗi ở route report, HTTP 503 `SCAN_REPORT_BUSY`; latency các response bị
từ chối khoảng 3,8–16,8ms, không phải 5s timeout. P95 còn thấp **không bù được**
error budget fail. Code `ScanReportService.acquireReportSlot()` dùng `tryAcquire`
trên semaphore 8 slot mặc định; cumulative auth 2.401 / remote 2.372 call chênh
đúng 29. Trừ baseline: burst có 1.801 report request, 1.772 remote call. Rejection
xảy ra ở Control Plane trước remote call; không mất accepted scan hoặc payment.

ClickHouse metadata 14.242 event row: baseline có 1.800 QueryFinish = 600 × 3 query,
burst có 5.316 = 1.772 × 3, zero exception. Cửa sổ burst query-start
11:17:03.228483–11:18:03.188511 UTC: server query nearest-rank p95 83ms/p99 101ms,
max 188ms, so với baseline p95 18ms/p99 26ms. **Query percentile không phải API
percentile.** Slow Crawler report log có page_list + summary lần lượt khoảng
100–186ms và state_read thường <1ms; chúng giữ remote slot lâu hơn. 26 mẫu 10s
toàn run: ClickHouse CPU peak 197,35% trong cap 2 CPU, Java 127,54%, Hikari active
max 1/pending/timeout 0, Tomcat busy max 4; free host RAM min 4,61 GiB, zero OOM.
Đã chứng minh cơ chế capacity rejection và server-query latency tăng cùng tải;
chưa tách scheduler/throttling/merge/query pipeline để kết luận nguyên nhân cuối
cùng hoặc chọn thay đổi capacity an toàn. Không tự tăng semaphore hay pool.

Final **FAILED_GATE**, kết thúc 18:18:42 UTC+7; source không đổi trong run, tất cả
tám container/anonymous volume và hai network do run sở hữu đã dọn. Counter rate
trong k6 summary tính cả setup/login, nên dùng activity window và request count
để mô tả offered RPS, không gọi summary rate thấp hơn là server throughput.
Không chạy hai benchmark song song. Không so 29 với 284 lỗi baseline cũ để công
bố cải thiện: dataset/JAR/warmup khác nhau và chưa có matched replicate.

### Kịch bản concurrency bị từ chối đúng

Lượt `8e42f9d5` clone 100 và 1.000 URL đã pass metadata/archive gate, lần lượt
65.247 ms và 190.175 ms. Tuy nhiên, hai clone đồng thời dùng cùng owner/target,
nên một request nhận 409 `WEBSITE_SCAN_ALREADY_ACTIVE`; request còn lại hoàn tất
62.758 ms. Outcome vẫn **FAILED_GATE**. Đây là sai workload của harness, không
phải lỗi runtime; không bỏ unique active-scan guard hoặc đổi quota. Bốn integration
test và inventory chưa chạy trong lượt thất bại này. Lượt `572afbca` dùng hai
owner độc lập để kiểm concurrency hợp lệ. Giữ cả hai evidence, không ghi đè.

## Roadmap còn lại và acceptance criteria

### Các kết luận chưa được mở rộng

- **Admission timeout production chưa có root cause đã chứng minh.** Baseline local
  burst 150 trước đó nhận 150/150 response/receipt nhưng p95 1.788ms/p99 1.795ms,
  fail latency gate và không tái hiện timeout 5s. Bản sửa hiện tại không đổi admission
  transaction/locking; admission 25 pass không đóng được mục này. Cần elapsed
  transport và filter/auth/connection/transaction/outbox timing cùng correlation.
- **Report overload là failure thực của workload đã chạy.** 13 rejection synchronized
  không biến thành thành công vì balanced 50 pass; workload peak có ý nghĩa riêng.
  Ba slow query matched đủ thu hẹp stage, chưa đủ chọn tăng semaphore/pool, cache,
  index hay điều chỉnh schema. Hikari pending 0 trong sample không loại trừ lock wait.
- **Production vẫn NO_GO full workload** theo báo cáo VPS ngày 12/10; local network,
  dataset mới/payload nhỏ và cùng máy phát tải không đại diện VPS, Cloud ClickHouse,
  R2, Internet hoặc 100.000 account/lịch sử 12 tháng. Không stress production,
  deploy workspace dirty, bật LIVE payment hoặc shutdown Windows trong đợt này.

| Ưu tiên | Công việc | Kiểm chứng / gate | Tác động Java Control Plane |
| --- | --- | --- | --- |
| P0 | Đóng gate correctness của clone và billing-disabled | Regression fail-first; 100/1.000 discovery, hai owner concurrent; archive hash/link/metadata đúng; PG/MinIO integration không skip; staging không sót | Giữ metadata accepted từ local; worker chỉ cung cấp progress/artifact; không đổi schema |
| P1 | Định lượng report overload và admission tail | Cùng dataset/runtime/cache policy, tối thiểu ba lượt độc lập; zero drop, error <0,1%; ordinary p95 <500ms/p99 <1s; report p95 <1s/p99 <2s; admission p95 <1s/p99 <2s; response đối chiếu durable receipt | Phân tách auth/remote/rejection; timeout không đồng nghĩa rollback; không nới pool/timeout khi chưa có dữ liệu |
| P1 | Tách server query latency khỏi client admission/network | Correlation/query_id, query profile/EXPLAIN và CPU/throttling/merge trong cùng cửa sổ; trước/sau cùng cardinality; chỉ chọn tuning sau khi chứng minh bottleneck | Giữ backpressure bounded; không cache cross-owner hoặc đổi consistency ngầm |
| P2 | Full-platform recovery và soak | Kill/restart worker giữa render/upload/publish, fencing/replay; không double publish/charge; orphan GC đúng; soak sau khi các nấc thấp pass | Outbox/reconciliation và domain state phải nhất quán; billing crash test không thay thế clone recovery |
| P2 | Production release readiness | Snapshot source sạch được review, build provenance, restore/rollback drill, telemetry đủ, load off-host hữu hạn qua gate; VNPAY SIT riêng nếu bật billing | Default billing off; không đưa sandbox thành live; local pass không tự gỡ NO_GO production |

Không tự tạo migration/index hoặc bổ sung service cho roadmap. Các mục cần database
work vẫn phải qua DESIGN_GATES. Benchmark trước/sau chỉ hợp lệ khi giữ cùng workload,
phần cứng, dữ liệu và gate; chưa có cặp matched cho các bản sửa trong báo cáo này.

## What the developer should understand before accepting this code

Condition trên configuration class không tự bảo vệ một Properties type được
scanner khác đăng ký. Test phải bao phủ cơ chế registration thực tế. Với Node HTTP,
xóa header khác với gán giá trị undefined. Fix correctness không tự chứng minh
capacity: cần kiểm error/drop budget cùng latency, và không suy rollback từ timeout.

Public DTO không phải wire DTO giữa service: Control Plane sở hữu website và thời
điểm accepted; worker sở hữu tiến độ/byte artifact. Compose sau owner authorization
và kiểm identity thay vì tin toàn bộ remote JSON. `archiveBytes` tính cả manifest,
không chỉ ZIP. Một active scan/website là invariant cần giữ, không phải trở ngại
cần bỏ để concurrency test pass. Database integration lease/replay không thay thế
process crash proof, còn Design Clone representative không là full-site backup.

Ponytail giữ diff runtime nhỏ; Spring Boot/testing kiểm feature gate và fail-closed;
Logging Patterns đối chiếu metadata/correlation; Encoding Guard kiểm UTF-8 trước
bàn giao. Chưa có production capacity, VNPAY SIT hoặc full-platform crash/soak proof.
Kiểm tra cuối: UTF-8 **12 file pass**, không cần repair; scoped `git diff --check`
pass (chỉ warning LF/CRLF). Docker inventory không còn container/network có label
`weblens.platform-benchmark`; chỉ `dictalab-redis` và `codex-lb` đang chạy, giữ nguyên.

## Evidence

- [Full-stack sau proxy/billing fix, report gate fail](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-42bc9fa4-7f33-4bc5-8589-9979a872ef66/final.json).
- [Report stage totals](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-42bc9fa4-7f33-4bc5-8589-9979a872ef66/api-baseline-report-stages.json)
  và [ClickHouse metadata](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-42bc9fa4-7f33-4bc5-8589-9979a872ef66/clickhouse-query-metadata.json).
- [Clone-only đúng hai owner](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-572afbca-994b-4a99-94ca-3a2fde41fe76/final.json),
  [PG/MinIO integration](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-572afbca-994b-4a99-94ca-3a2fde41fe76/capture-integration.log)
  và [inventory sau GC](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-572afbca-994b-4a99-94ca-3a2fde41fe76/clone-storage-inventory.json).
- [Lượt concurrency sai workload, giữ nguyên outcome fail](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-8e42f9d5-9d4d-4e5f-b78c-31a74d2f95e9/final.json).
- [API balanced final](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/final.json),
  [150 RPS metrics](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/api-burst-summary.json),
  [stage totals](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/api-burst-report-stages.json)
  và [query metadata](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/clickhouse-query-metadata.json).

Evidence local nằm dưới `tmp/` bị Git ignore: giữ trên máy không đồng nghĩa đã có
off-host backup. Source/JAR/image hash, runtime limits, log, samples và cleanup ở
thư mục tương ứng; không commit credential hoặc raw production dữ liệu.
