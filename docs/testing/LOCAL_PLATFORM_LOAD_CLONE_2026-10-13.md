# Local platform load + Design Clone — 2026-10-13

## Kết luận

Kết quả full-workload là **NO_GO**. Application
không khởi động với cấu hình billing mặc định; clone HTTP chưa tạo được archive;
mixed read dồn pha 50 RPS vượt error budget dù latency đạt; admission burst 150
vượt latency gate. Mixed traffic lệch pha 50 RPS đã đạt riêng. Không deploy production,
không sửa Java/Go/Capture runtime hoặc database schema trong đợt này.

## Phạm vi, provenance và môi trường

- Source workspace dirty; manifest giữ source/JAR/image SHA-256. Đây không phải
  artifact release, không có matched historical baseline trước/sau sửa backend.
- Máy local Windows: Ryzen 7 PRO 6850HS, 16 logical CPU, khoảng 31,3 GiB RAM.
  Generator k6 và Docker target cùng máy, có workload người dùng khác cùng chạy.
- Build backend bằng Java 21 trên Windows; runtime Java là Temurin 21.0.12+8
  Linux trong Docker. PostgreSQL 17.6; ClickHouse 26.3; Redis 7.4; MinIO và
  Capture image theo Dockerfile hiện hữu. Image ID được pin trong từng manifest.
- PostgreSQL một instance test với ba database riêng, cap 2 CPU/1 GiB; Java
  2 CPU/1536 MiB, heap 1024 MiB, Hikari 32/min 16; ClickHouse 2 CPU/1536 MiB;
  Crawler 2 CPU/768 MiB, 16 global fetch/2 mỗi host, zero delay chỉ cho fixture;
  Capture 2 CPU/2 GiB, Camoufox headless và 2 page/process. Không đổi production pool.
- Fixture dùng public-form IP chỉ trong namespace Docker `--internal`. Crawler,
  Capture và fixture không có bridge Internet. Chỉ Java nối thêm bridge ingress
  cho k6 qua loopback. SSRF source không thay đổi; đây **không** là bằng chứng
  DNS/TLS/egress isolation trên production. Không fetch website bên thứ ba.
- Billing vẫn tắt. Workaround để benchmark: cấp profile/catalog sandbox giả
  qua environment vì lỗi bind mặc định bên dưới. Không dùng secret thật, không
  gọi VNPAY và không thu phí scan/clone.
- Dataset mới, leaf scan một trang cho mỗi owner; không seed 100.000 account hoặc
  lịch sử 12 tháng. Không dùng kết quả này để công bố capacity đó.

## Các lượt đo đã hoàn tất

| Lượt | Workload | Kết quả | Latency end-to-end / HTTP |
| --- | --- | --- | --- |
| Full-stack đầu | Admission 25 owner distinct | 25/25 HTTP 202; durable scan/outbox khớp | elapsed p95 224,6 ms |
| Full-stack đầu | Mixed 50 RPS, 60s, tối đa 25 VU | 3.001 iteration, 0 dropped; 8 lỗi/3.001 = 0,267%; FAIL | activity HTTP p95 52,323 ms, p99 108,632 ms |
| API-only chẩn đoán | Admission 25 owner distinct | 25/25 HTTP 202; durable scan/outbox khớp | elapsed p95 646 ms |
| API-only chẩn đoán | Mixed 50 RPS, 60s, tối đa 25 VU | 3.001 iteration, 0 dropped; 10 lỗi/3.001 = 0,333%; FAIL | activity HTTP p95 50,953 ms, p99 123,429 ms |
| Admission-only | Burst 150 owner distinct, một POST/key, timeout 5s | 150/150 HTTP 202; durable scan/outbox khớp; zero status 0; FAIL latency | elapsed p95 1.788 ms, p99 1.795,02 ms |
| API-only lệch pha | Mixed 50 RPS, 60s, tối đa 25 VU, route offset theo VU | 3.001 iteration, 0 dropped, 0 lỗi; PASS local | activity HTTP p95 57,162 ms, p99 79,493 ms |
| API-only lệch pha | Mixed 150 RPS, 60s, tối đa 25 VU, route offset theo VU | 9.001 iteration, 0 dropped, 284 lỗi = 3,155%; FAIL | activity HTTP p95 284,949 ms, p99 364,836 ms |

Các lượt dùng cùng JAR SHA-256
`67f4076f7f79b145dfa3a034f26266158cdab830b3e4e2c85a80deb7e98735ca`.
P95 admission khác nhau không chứng minh cải thiện/regression: full-stack đã chạy
clone trước admission, còn API-only là JVM mới với uptime/cache/JIT khác.

50 RPS là arrival rate trong cửa sổ 60s, không phải `http_reqs.rate` của summary:
k6 tính rate đó trên cả setup login. Một iteration = một activity GET, không
retry lỗi 503. 3.001 iteration là boundary timing của executor, không phải thêm
3.001 account hoặc concurrent transaction. Không có dropped iteration nên bài đo
không bị thiếu offered iteration; nó vẫn FAIL error budget.

Latency endpoint trong lượt API-only chẩn đoán:

| Endpoint role | p95 ms | p99 ms |
| --- | ---: | ---: |
| Dashboard | 8,782 | 11,726 |
| Website list | 12,289 | 24,072 |
| Scan list | 11,732 | 13,579 |
| Scan progress | 8,584 | 10,007 |
| Scan pages/report | 125,319 | 262,157 |

17 resource samples, cách khoảng 10s: host free RAM thấp nhất khoảng 4,04 GiB;
Java CPU sample cao nhất 62,3% (Docker 100% = một logical CPU), ClickHouse 135,98%;
Hikari pending/timeout sample đều 0. Đây không loại trừ spike giữa sample hoặc
thời gian chờ khác. DB cuối lượt: 41 connection, zero deadlock/temp-byte ở ba DB.
Crawler `xact_rollback` cao không tự chứng minh lỗi: empty claim đi qua transaction
và deferred rollback hiện hữu; cần phân loại trước khi gắn với failed business write.

## Root cause và bằng chứng

### 1. Application startup khi billing tắt — lỗi thực tế, độ tin cậy cao

**Evidence:** Lượt bootstrap `17b0bf76` dừng với
`ConfigurationPropertiesBindException`, bean
`weblens.billing-com.weblens.billing.config.BillingConfiguration$Properties`,
reason `Billing requires an active profile and credit catalog`.
`WebLensApplication` dùng `@ConfigurationPropertiesScan` toàn package;
record `BillingConfiguration.Properties` vẫn được scan độc lập với condition
trên configuration class. Unit test disabled dùng context hẹp, không đưa scanner
của main application vào nên không phát hiện lỗi.

**Minimal fix đề xuất, chưa triển khai:** registration/binding của Properties phải
chịu cùng feature gate; giữ validation đầy đủ khi enabled. Test context phải có
scanner như main app: disabled/no secret/catalog startup được và không có billing
bean/controller; enabled/missing hoặc LIVE phải fail closed.

**Verification:** khởi động JAR trên DB/Redis test với billing mặc định, không
profile/catalog giả; health UP và endpoint billing không được kích hoạt. Workaround
của harness không được tính là test pass của default configuration.

### 2. SafeProxy HTTP forward — lỗi thực tế, độ tin cậy cao

**Evidence:** `capture-worker/src/safe-proxy.ts` gửi
`'proxy-connection': undefined` trong Node `http.request` headers. Diagnostic ngay
trong Capture container của lượt full-stack: direct fixture reachable, proxy GET
trả 502/0 byte; Node request với header undefined ném
`ERR_HTTP_INVALID_HEADER_VALUE`. Browser launch/context/page riêng khởi động được;
đây không phải bằng chứng Camoufox binary thiếu. Không suy lỗi này áp dụng cho
nhánh HTTPS CONNECT vốn dùng code khác.

Clone smoke public API tạo scan mới, cùng idempotency key trả cùng clone/scan,
owner khác nhận 404. Crawler terminal `PARTIAL_SUCCESS`; renderer chọn 10 ứng viên,
nhưng các attempt gặp deadline khoảng 60s và `SITE_CLONE_OPERATION_FAILED`, không
có page thành công hoặc artifact. Operator hủy sau khi lấy bằng chứng; public
state đi `CANCEL_REQUESTED` → `CANCELLED`, 198 page-work đều CANCELLED. Không gọi
đây là clone E2E pass hoặc full crash/cancel cleanup certification.

**Minimal fix đề xuất, chưa triển khai:** xóa header khỏi copy trước `http.request`,
không đặt giá trị undefined; giữ host rewrite, DNS pinning, SSRF, byte budget,
timeout và close-on-error. Integration test HTTP fixture thật qua SafeProxy phải
nhận body 200; private/redirect target vẫn blocked.

**Secondary finding:** fixture cũ có link English → English root làm crawl mở thêm
locale và đạt 198 thay vì 100 URL. Đây là lỗi fixture, không phải bằng chứng
crawler double-count. Đã sửa fixture để locale thay thế là leaf, kèm test; giữ
nguyên artifact lượt cũ. Chưa rerun clone 100/1.000 sau sửa runtime.

### 3. Mixed API error budget — overload được xác nhận, chưa là lỗi transaction

**Evidence:** Lượt chẩn đoán ghi 10 trace, đều `scan_pages`, HTTP 503,
`SCAN_REPORT_BUSY` tại 10:12:43–10:12:44 UTC; elapsed HTTP khoảng 8,6–63,9 ms.
`ScanReportService.acquireReportSlot()` dùng semaphore 8 và `tryAcquire()` fail-fast.
Không phải 5s admission timeout, không phải bằng chứng Hikari timeout hoặc mất scan.

Harness chọn route theo `__ITER % paths.length`; các VU cùng vào report ở iteration
4. Nó tạo report burst trên cold endpoint dù arrival rate toàn API là 50 RPS.
Việc fail error budget là thật cho workload này. Không kết luận mọi traffic 50 RPS
đều fail hoặc bỏ load-shedding để ép pass. Lượt đầu không có error-code trace nên
chỉ biết 8 lỗi; không gán chắc cả 8 cùng root cause với lượt sau.

**Verification tiếp:** giữ bài synchronized như burst test; thêm VU-offset mixed
test có label riêng, đo endpoint counts, Hikari/threads và report timing, rồi tăng
50 → 150 → 500 RPS nếu gate đạt. Khác workload không phải benchmark trước/sau sửa.
Không tự tăng PostgreSQL/ClickHouse pool hoặc retry 503 trong measured iteration.

Lượt API-only `ba2ce644` bật route offset theo VU, default synchronized vẫn giữ
nguyên và được báo riêng. Nấc 50 RPS/60s đạt 3.001 iteration, zero error/drop,
activity p95 57,162ms/p99 79,493ms. Endpoint counts lần lượt dashboard 601,
website 601, scan-list 602, progress 598, report 599: đã thực sự đo đủ năm role.
Đây là ảnh hưởng **workload**, không phải sửa semaphore hay tối ưu backend.

Nấc 150 RPS/60s có 9.001 iteration, zero dropped nhưng 284 lỗi, cả 284 trace là
503 `SCAN_REPORT_BUSY`. Trong 1.804 report request, 284 bị từ chối (~15,74%);
error budget toàn activity là 3,155%. Report HTTP p95 364,788ms/p99 402,765ms vẫn
đạt latency gate nhưng không đủ acceptance. Bốn endpoint role còn lại p95 khoảng
6,4–7,6ms. Không chạy 500 RPS/120s hoặc soak 150 RPS/300s sau fail này.

26 resource samples cho cả lượt: Hikari active max 1, pending/timeout max 0;
Tomcat busy max 9; host free RAM min 5,18 GiB; Java peak CPU sample 149,02%,
ClickHouse 201,46% gần ngân sách 2 CPU, PostgreSQL 23,36%. Không container bị
OOMKilled. 10s sampling không đo được microburst hoặc exact queue wait.
ClickHouse CPU pressure/remote duration có thể góp phần giữ slot report lâu,
nhưng chưa có matched query/CPU-throttling evidence để kết luận sâu hơn. Không
thay load shedding/pool hoặc thêm cache/infrastructure cho một bài đo.

### 4. Admission 150 burst — latency fail, chưa xác định root cause sâu hơn

Lượt độc lập `ad50f00c`: 150 tài khoản/websites khác nhau, auth setup pacing 1,1s,
runtime đủ ba deployable và dispatch bật. Cả 150 response 202 khớp scan/outbox;
không status 0, không POST replay hoặc nới timeout. Latency end-to-end min 903 ms,
median 1.395 ms, p95 1.788 ms, max 1.796 ms. Đã FAIL gate p95 <1.000 ms, không
được gọi successful capacity vì correctness đạt.

Phân tích theo **cùng correlation**, percentile nearest-rank trên 150 observation:

| Phần đo | Median ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: |
| Thân `ScanService` | 106,6 | 538,0 | 595,1 |
| Completion sau thân service | 8,0 | 87,8 | 94,4 |
| Controller gọi service, gồm proxy transaction | 299,6 | 811,3 | 1.506,0 |
| Filter request elapsed | 916,8 | 1.485,7 | 1.695,4 |
| `filter elapsed - service call` từng request | 469,3 | 1.089,0 | 1.501,2 |
| `client elapsed - filter elapsed` từng request | 484,0 | 892,0 | 1.084,7 |

Không cộng/trừ p95 của các hàng để tạo latency breakdown: percentile không cộng
được và mẫu chậm nhất có thể khác nhau. Các số delta tính từng request trước khi
aggregate. Phần ngoài service có thể gồm authentication/session validation,
authorization, Spring filter/response/logging và scheduling; phần client ngoài
filter có thể gồm accept/servlet queue, transport và load generator. Chưa có stage
timer để tách chúng, không được gán chắc cho Redis, Hikari hoặc network.
DB snapshot cuối: 50 connection, zero deadlock/temp-byte ở ba database; snapshot
không loại trừ pool wait ngắn. Không tắt auth hoặc tăng pool để ép gate pass.

Tiếp theo cần matched 25→50→150 ít nhất ba lượt mỗi cell với cùng warm/cold
connection và stagger policy; ghi auth/Redis/SQL-revocation stage, Tomcat queue/
threads và pool wait đủ độ phân giải. Giữ đúng 5s timeout và reconciliation sau
ambiguous response. Đợt local không tái hiện timeout 5s production, nên root cause
production vẫn cần correlation evidence trên runtime/dataset đó.

## Acceptance gates và các phần chưa chứng minh

- Ordinary API p95 <500ms/p99 <1s; scan pages p95 <1s/p99 <2s; activity error
  <0,1%, checks >99,9%, zero dropped iteration. Admission: p95 <1s/p99 <2s,
  error <1%; từng accepted response phải khớp scan/outbox đúng correlation.
- Clone phải tải ZIP/manifest thật qua Java, xác minh size/SHA-256/attachment/
  no-store/nosniff, role/locale, shared asset một bản, JS rendered và link offline.
  Có idempotent request, wrong-owner 404 và progress monotonic. Hiện chưa đạt.
- Sau smoke fail đã dừng clone 1.000 URL và không gửi large clone vào production.
  100.000 page ceiling, concurrent clone throughput, shard lớn, crash recovery,
  browser session/login, metadata-retention purge, production API p95 và timeout
  production chưa được chứng minh bởi đợt này.
- Báo cáo VPS ngày 2026-10-12 vẫn NO_GO full-workload; read-only 100 RPS/10 phút
  trước đây không được thay thế bằng local run này.

## Roadmap để mở lại benchmark

| Ưu tiên | Công việc | Test/acceptance | Tác động Java Control Plane |
| --- | --- | --- | --- |
| P0 | Feature-gate billing Properties đúng ở full app | Default startup không cần secret; enabled thiếu config/LIVE fail | Gỡ blocker khởi động, không thay payment transaction/schema |
| P0 | SafeProxy forward HTTP hợp lệ | HTTP fixture 200/body; SSRF/redirect/budget regression pass | Scan→clone có cơ hội publish; API/download contract giữ nguyên |
| P1 | Giữ hai workload report synchronized và lệch pha | Trace 503 + endpoint mix; zero dropped; không che lỗi bằng retry | Đo slot pressure, 503 load-shedding và remote service time |
| P1 | Tách admission filter/auth/queue khỏi transaction | Matched burst 25/50/150, ba lượt; p95/p99 elapsed đạt, receipt đúng; timeout vẫn 5s | Không đổi business locking; thêm stage evidence trước tuning |
| P1 | Clone smoke rồi 1.000 URL; sau đó 2 job song song | Archive verification, đúng owner, cancel, staged-publish/GC; đo queue→terminal và peak RAM | Đo dispatch/projection freshness, download occupancy; giữ ba boundary |
| P2 | Capacity dataset đại diện và matched before/after | Seed cardinality đã duyệt, cùng JAR/config/hardware/cache policy; ít nhất ba lượt | Phân biệt DB/query bottleneck với remote/browser bottleneck |
| P2 | Rehearsal staging/VPS có quyền kiểm soát | Read SLO + fresh scan→clone terminal, backlog recovery, không mất accepted work | Chỉ promote khi functional/reliability gate và rollback đều đạt |

## Kiểm thử harness, thay đổi và cleanup

Đợt này chỉ thêm `local-platform-benchmark.mjs` và self-test; bổ sung metrics-only
summary cho k6 admission, opt-in error tracing/correlation/VU route offset cho
mixed k6; cập nhật README và báo cáo. Không thêm dependency/service/schema mới.
Nguồn runtime không đổi. Exit code mới là nonzero khi gate fail; phase API-only
hoặc admission-only không được gắn PASS_FULL_STACK.

Java build: 177 test pass, zero failure/error/skip; không chạy toàn bộ Java IT
trong lần package này (`-DskipITs`). Capture: 57 pass, 10 skip (6 browser smoke,
3 PostgreSQL integration, 1 MinIO integration chưa cấu hình ở lệnh unit ban đầu).
Load harness smoke và negative/self-check pass. Không gọi tên `.e2e.test.ts` của
selection/assembly thuần dữ liệu là toàn chuỗi browser/MinIO/Java E2E.

Các container/anonymous volume/network do cả năm run sở hữu đã được dọn sau lượt
hoàn tất; log/manifest/metric/lifecycle giữ trong `tmp/load/platform-<runId>/`.
Container người dùng không bị thay đổi. Build images giữ lại trong cache.

## What the developer should understand before accepting this code

P95 thấp không đủ nếu error budget fail. At-least-once workflow correctness khác
throughput. Admission latency phải gồm connection/queue/response, và timeout không
chứng minh rollback. Semaphored 503 là backpressure có chủ đích; cần đo workload
burst trước khi đổi concurrency. Unit slice không thay full application startup.
Design Clone giữ representative, không render/backup mọi discovered URL.

[Ponytail](C:/Users/HP/.codex/plugins/cache/ponytail/ponytail/5.2.0/skills/ponytail/SKILL.md)
giữ thay đổi ở harness, tái sử dụng k6/runtime/dependency hiện có.
[Spring Boot Failure Analyzer](C:/Users/HP/.codex/skills/spring-boot-failure-analyzer/SKILL.md)
và [Logging Patterns](C:/Users/HP/.codex/skills/logging-patterns/SKILL.md) giúp phân
biệt startup binding, proxy error và report-capacity rejection bằng evidence.
[Vietnamese Encoding Guard](C:/Users/HP/.codex/skills/vietnamese-encoding-guard/SKILL.md)
kiểm tra tài liệu và harness UTF-8; kiểm tra cuối đợt đã pass, không cần repair.

## Evidence local

- [Bootstrap lỗi mặc định](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-17b0bf76-305e-4ce5-957a-2c25b3b055ab/control.log).
- [Full-stack clone/admission/read run](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-f0dfc67d-23eb-4167-a53d-3798e379663b/final.json).
- [API synchronized có trace lỗi](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-f94da1f8-524c-4f4c-a631-946ac2347eb8/final.json).
- [Admission burst 150](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-ad50f00c-e70c-4523-9c69-792cd8012648/admission-150-verified.json).
- [Mixed lệch pha 50/150 RPS](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-ba2ce644-4bc5-4e0a-b56b-04379752dead/final.json).

Mỗi thư mục chứa manifest, source hash, resource/state samples, log và cleanup.
Không coi tên scenario dự kiến là bằng chứng đã chạy: clone-large/500-RPS/soak
bị dừng trước khi chạy do gate tương ứng thất bại.
