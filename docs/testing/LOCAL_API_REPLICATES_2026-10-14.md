# API replicate và CPU quota — 2026-10-14

## Kết luận

Ba lượt local độc lập đã hoàn tất. **50 RPS/60s pass cả ba; 150 RPS/60s fail cả
ba do error budget**, dù latency vẫn dưới ngưỡng. Tất cả lỗi activity được trace
là HTTP 503 `SCAN_REPORT_BUSY`; không có dropped iteration. Không chạy 500 RPS
hoặc soak qua gate thất bại. Production full workload vẫn **NO_GO**.

Cgroup xác nhận ClickHouse bị CPU throttling trong cửa sổ burst ở cả ba lượt,
không chỉ CPU sample gần cap. Đây là bằng chứng pressure mới; chưa chứng minh
throttling là nguyên nhân duy nhất, hoặc root cause admission timeout production.
Không sửa runtime, tăng pool/semaphore/timeout, đổi schema hoặc deploy.

Tiếp nối [checkpoint timing](LOCAL_ADMISSION_TIMING_DIAGNOSIS_2026-10-14.md) và
[correctness/clone ngày 13/10](LOCAL_PLATFORM_RELIABILITY_FIX_2026-10-13.md).
Docker engine đã hoạt động lại sau khi người dùng chọn tự xử lý. Agent không sửa
socket, reset Docker, đổi phiên bản hoặc xóa container/volume của người dùng.

## Protocol và provenance

Lệnh cho từng lượt, chạy tuần tự, không benchmark song song:

```powershell
node tools/load/local-platform-benchmark.mjs --acknowledge-high-load --api-only --balanced-mix
```

Mỗi lượt dùng stack mới, 25 owner độc lập, 25 scan leaf thật đã hoàn tất, 25 VU max,
zero think time, một GET/iteration và route offset theo owner. Login được pace
trong setup. Không clone warmup. ClickHouse/Java/Crawler mỗi container cap 2 CPU;
Java heap 1 GiB, Hikari 32/16; ClickHouse 1536 MiB. Billing disabled không catalog
giả. Fixture/browser/crawler nằm trên bridge internal, không scan Internet.

Ba manifest cùng source digest
`bdaf196215ced14561a752f74d45ad4cc1b9f5e2b394ef6054f4fbd2255fc6eb`, JAR SHA-256
`1b1beecdaecaebc0eca89cfb8be190493a734caba72182650e6eb1c42a068f97`, image ID và
config. Source giữ nguyên trong mỗi experiment. Ngoại trừ harness đã bổ sung,
các source được hash và JAR vẫn khớp baseline `fe28cdf4`; không rebuild runtime.

Đây là replicate cùng **đầu vào/config/cardinality**, không phải ba bản sao trạng
thái vật lý tuyệt đối: UUID khác, parts/merge, cache/JIT và host contention không
được khóa. Máy phát tải cùng máy target; database mới/payload nhỏ, không TLS/Caddy,
Cloud ClickHouse/R2/VPS hoặc 100.000 account/lịch sử 12 tháng. Không gộp các lượt
thành một distribution; không dùng counter rate gồm setup làm activity throughput.

## Benchmark thực tế

Đơn vị latency: ms. Percentile trong bảng lấy từ k6 gốc.

| Run | Pha / offered RPS | Activity request | Lỗi / drop | Activity p95 / p99 | Report p95 / p99 | Gate |
| --- | --- | ---: | --- | --- | --- | --- |
| `9551b001` | 50 / 60s | 3.001 | 0 / 0 | 47,60 / 70,78 | 66,08 / 89,99 | PASS |
| `9551b001` | 150 / 60s | 9.000 | 50 (0,556%) / 0 | 70,89 / 237,82 | 237,81 / 306,06 | FAIL |
| `cd11504b` | 50 / 60s | 3.001 | 0 / 0 | 51,58 / 82,70 | 77,69 / 146,69 | PASS |
| `cd11504b` | 150 / 60s | 9.001 | 44 (0,489%) / 0 | 55,65 / 220,99 | 221,06 / 297,31 | FAIL |
| `04bdeab4` | 50 / 60s | 3.001 | 0 / 0 | 56,52 / 72,14 | 68,40 / 115,18 | PASS |
| `04bdeab4` | 150 / 60s | 9.001 | 268 (2,977%) / 0 | 278,52 / 348,38 | 348,28 / 398,19 | FAIL |

Gate giữ nguyên: activity error <0,1%, checks >99,9%, zero drop; ordinary route
p95 <500ms/p99 <1s; report p95 <1s/p99 <2s. P95 pass không bù error budget fail.
Các route đều có request và authorization thật. Final cả ba là `FAILED_GATE`.

Admission 25 owner chạy trước các pha API:

| Run | Response 202 / durable scan-outbox | p95 / p99 | Timing ghép đủ | Gate |
| --- | --- | --- | --- | --- |
| `9551b001` | 25/25, ánh xạ một-một | 482,00 / 485,52 | 25/25 | PASS |
| `cd11504b` | 25/25, ánh xạ một-một | 438,80 / 439,00 | 25/25 | PASS |
| `04bdeab4` | 25/25, ánh xạ một-một | 517,40 / 518,76 | 25/25 | PASS |

Không có transport timeout trong admission này. Không chạy mới admission 50/150;
ba lượt 25 không đóng được timeout production hoặc burst 150 lịch sử.

## Root cause: điều đã chứng minh và giới hạn

### Report rejection tại Java

`ScanReportService` giữ semaphore 8 slot và `tryAcquire()` fail-fast. Burst auth /
remote timer delta lần lượt **1.801/1.751**, **1.800/1.756**, **1.803/1.535**;
chênh lệch đúng 50, 44, 268 lỗi k6. QueryFinish đúng remote × 3: 5.253, 5.268,
4.605. Rejection xảy ra trước remote call, không phải ClickHouse exception hoặc
mất accepted scan. Mã `networkErrorCode=1503` đi kèm HTTP 503 trong k6 không được
diễn giải thành TCP timeout.

Đã chứng minh cơ chế lỗi trực tiếp: report slot không còn -> Java trả 503. Server
query chậm hơn giữ remote slot lâu hơn; pressure downstream là hướng điều tra
có bằng chứng. Chưa định lượng nhân quả của từng thành phần trong tail hoặc
khẳng định chỉ cần tăng semaphore là an toàn.

### CPU quota và query metadata

`cpu.max`/`cpu.stat` được đọc trước/sau **toàn invocation k6**, gồm setup/login và
probe boundary; không phải đúng riêng 60s activity. Fraction là delta nr_throttled
/ delta nr_periods. Throttled time là counter cgroup, không wall-clock downtime,
request latency hoặc CPU utilization; không cộng nó vào API p95.

| Run | CH baseline throttled periods | CH burst throttled periods | Burst throttled counter, ms | Query p95 baseline -> burst |
| --- | --- | --- | ---: | --- |
| `9551b001` | 0/976 | 212/978 (21,68%) | 60.666,765 | 19 -> 88ms |
| `cd11504b` | 4/978 | 159/975 (16,31%) | 44.189,675 | 22 -> 80ms |
| `04bdeab4` | 5/979 | 561/978 (57,36%) | 262.212,990 | 22 -> 109ms |

Java và Crawler có **zero delta throttling trong cả ba burst**. Java baseline có
4–5 throttled periods; không nói toàn run không throttling. Không có QueryFinish
exception trong cửa sổ trên. Mean read rows/query baseline/burst: 66,667/66,667;
66,667/66,667; 55,893/55,934, max 100. Chưa thấy read volume mỗi query tăng theo
tải trong cùng run; physical read volume giữa run không hoàn toàn giống nhau.
Query percentile là distribution query, không phải API request.

Một slow summary query `...3919c` của lượt 1 ghép đúng query_id: Crawler
query/read 292,102ms, admission wait 0,000351ms; ClickHouse 291ms, read 100 rows /
5.008 bytes. Với query này, server execution/wait chiếm gần hết client interval.
Không suy một sample thành phân rã của mọi report hoặc production.

### EXPLAIN sau tải, không sửa SQL

Lượt 3 thu `clickhouse-summary-plan.json` sau khi activity kết thúc. Query được
trích trực tiếp từ `ScanSummary()` trong Go, kiểm hai database substitutions và
bốn UUID bindings; không viết query tương tự khác. Fingerprint template:
`44a5ee64f30bed9ded5b78b6537781e5f50620c169cebac3e4db93512fe5b3c6`.
Probe dùng HTTP cùng tài khoản ClickHouse local; không phải execution profile
của native query đang chạy. Plan có UUID **synthetic local**, không production.

- `max_threads` và `max_final_threads` đều `auto(2)`; không có bằng chứng default
  dùng toàn bộ CPU host. Không tự tăng threads hoặc resource quota.
- Hai nhánh `page_metrics`/`findings` có primary-key owner_id/scan_id condition
  và binary search. Trong plan này vẫn chọn 3/3 parts, 3/3 granules mỗi nhánh.
  Không thể kết luận thiếu owner index hoặc filter cross-owner từ read amplification.
- Pipeline có `ReplacingSorted 3 -> 1`, join và aggregation transforms. Không bỏ
  FINAL/version dedup hoặc đổi summary count để làm benchmark nhanh hơn.
- Đây là snapshot sau burst trên dataset leaf nhỏ, không đủ tách merge/background
  work/scheduler cost, chứng minh schema kém hoặc thay thế profile lúc tải cao.

28 resource sample/10s mỗi lượt: Hikari active max 1, pending/timeout sampled 0;
host RAM free min khoảng 7,99–8,10 GiB. State của các container Java/Go/Capture/PG/CH
không OOMKilled; PG counters deadlock/temp bytes 0. Sample không loại trừ transient
lock/acquisition wait. Crawler DB xact_rollback 4.837–4.843 không đồng nghĩa lỗi
nghiệp vụ: `ClaimPage` có nhánh no-row return cùng deferred rollback; chưa gán
toàn bộ rollback counter cho nhánh này khi chưa có per-operation evidence.

### Admission chưa đóng root cause production

Mean của từng tập 25 request, không cộng independent percentile:

| Run | Client elapsed | Body | After-body interval | Within-filter residual | Outside-filter residual |
| --- | ---: | ---: | ---: | ---: | ---: |
| `9551b001` | 444,080 | 190,094 | 18,859 | 227,993 | 7,134 |
| `cd11504b` | 430,160 | 189,775 | 37,103 | 195,520 | 7,762 |
| `04bdeab4` | 509,240 | 241,514 | 3,107 | 255,862 | 8,757 |

Phần ngoài body vẫn đáng đo. Within-filter residual gồm auth/session/revocation,
transaction entry, MVC/serialization và scheduling; body bắt đầu sau transaction
interceptor. Outside-filter residual không phải pure network. Burst 150 lịch sử
p95 1.788ms và residual lớn hơn vẫn là workload khác; không gọi chênh lệch với 25
ở đây là hiệu quả bản sửa hoặc bằng chứng timeout production đã hết.

## Thay đổi, regression và cleanup

- `local-platform-benchmark.mjs`/test: gate admission bijection và CPU quota helper;
  timing helper từ checkpoint trước đã được kiểm live. Gate cũ có thể để observation
  lặp che request/receipt thiếu. Đây là lỗi validator tái hiện được, không khẳng định
  evidence lịch sử đã hỏng. Sáu artifact admission cũ đều pass validator mới.
- CPU parser từ chối missing/duplicate/malformed/reset counter hoặc quota thay
  đổi; snapshot không hợp lệ ghi unavailable. Probe không đổi SLO hoặc runtime
  resource limits; không xuất credential/arbitrary fields.
- Fail-first import helper chưa có thất bại; sau implementation **16 harness tests
  pass, zero fail/skip**. Bao phủ receipt trùng/thiếu/sai identity và counter âm/reset.
- Files trong phạm vi: hai harness files, `tools/load/README.md`, checkpoint timing
  và báo cáo này. Không Java/Go/Capture runtime, dependency, Flyway/schema hoặc
  service mới. Không chạy lại 181 Java unit/22 billing IT/4 PG-MinIO hôm nay;
  kết quả cũ giữ đúng ngày và phạm vi trong báo cáo ngày 13/10.
- Clone không chạy lại trong ba API-only experiment. Gate local 100/1.000 discovery
  và hai owner concurrent từ lượt `572afbca` đã pass; mỗi job package 10 representative.
  Không nói đã render 1.000 trang hoặc kiểm process-kill full-platform recovery.
- Final xác nhận dọn đủ 24 container/anonymous volume và 6 network do ba run sở
  hữu; evidence giữ nguyên. Inventory cuối không còn label benchmark. Chỉ
  `dictalab-redis` và `codex-lb` chạy, giữ nguyên. Không shutdown Windows.
- Verification cuối: chạy lại **16 test pass, 0 fail/skip**, Node syntax check pass,
  UTF-8 **5 file pass**, không repair. Scoped tracked `git diff --check` pass,
  chỉ warning LF/CRLF; untracked harness/report được kiểm trực tiếp, không coi
  toàn bộ dirty diff của workspace là thay đổi đợt này.

## Roadmap, acceptance và tác động Control Plane

| Ưu tiên / trạng thái | Test hoặc experiment tiếp theo | Acceptance / benchmark trước-sau | Tác động Java |
| --- | --- | --- | --- |
| P0 DONE — evidence gate | Duplicate/missing response/receipt, wrong owner/scan/correlation; valid shuffled receipt | Invalid evidence luôn fail; sáu bộ cũ và ba bộ mới ánh xạ một-một; 16 regression pass | Không thay transaction; không tạo API seed khi consistency fail |
| P1 OPEN — report CPU/slot occupancy | Profile pipeline/parts/merge lúc tải; thử một yếu tố mỗi lần trên local với owner isolation, version replay/dedup, finding/status counts và freshness regression | Before: ba burst 44–268 lỗi, error 0,489–2,977%. After: ba matched burst 150 RPS, error <0,1%, zero drop; ordinary p95 <500ms/p99 <1s, report p95 <1s/p99 <2s; 50 RPS vẫn pass. Chưa có after | Giữ 8-slot fail-fast và bounded remote pool cho đến khi chứng minh capacity; không đổi consistency/FINAL để tăng điểm |
| P1 OPEN — admission tail | Matched 25 -> 50 -> 150, dừng sau low-level gate fail; correlation cho auth/Redis/revocation, tx entry/Hikari, MVC/connector/JVM và receipt | Mỗi nấc p95 <1s/p99 <2s, timeout 5s giữ nguyên, zero duplicate/lost receipt; không replay POST mù. Before 150 lịch sử fail latency; chưa có matched after 50/150 | Instrument đúng boundary trước khi đổi lock/pool/timeout; response timeout không suy ra rollback |
| P2 OPEN — clone recovery/soak | Kill/restart worker giữa render/upload/publish; replay event, expiry/fencing, cancel/GC; soak chỉ sau burst pass | Không double publish/charge, không mất accepted job, metadata/hash đúng, orphan/staging được thu gom; integration không skip | Outbox/inbox/projection và accepted metadata vẫn nhất quán; billing JVM crash test không thay clone crash drill |
| P2 NO_GO — release production | Source snapshot sạch được review, build provenance, restore/rollback drill, off-host load hữu hạn, telemetry; VNPAY SIT riêng nếu bật billing | Đóng gate local trước; production scan/capture/clone workflow và error/latency/drop budget phải pass trên hạ tầng thật; sandbox không thành live | Không deploy dirty tree hoặc bật live payment; giữ ba deployable và DESIGN_GATES |

Đợt này đóng phần replicate/receipt/CPU evidence, **không đóng toàn bộ roadmap**.
Không có matched before/after performance fix: runtime chưa đổi; harness correctness
fix không được quảng bá thành tăng throughput. Chưa benchmark đủ retention/cardinality
cho claim tải lớn production, nên không đưa con số 150/500 RPS thành capacity trên CV.

## What the developer should understand before accepting this code

Backpressure bảo vệ downstream nhưng rejection vẫn tiêu error budget. P95 thấp
không đồng nghĩa dịch vụ đáp ứng SLO. Counter cgroup, query percentile, timer
cumulative và API percentile đo bốn thứ khác nhau. FINAL/version dedup và owner
filter là correctness boundary, không được bỏ để benchmark pass. Receipt bijection
chứng minh command bền vững; log COMMITTED và HTTP timeout không thay nó.

Ponytail giữ thay đổi trong harness, không tuning runtime khi chưa có counterfactual;
Logging Patterns đối chiếu identity và counter; Encoding Guard kiểm UTF-8 tài liệu.
Các thiếu bằng chứng còn lại gồm production timeout, matched tuning after,
admission 50/150 mới, full-platform crash/soak và production release readiness.

## Evidence

- [Lượt 1 final](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-9551b001-592d-4255-8c10-99cfa2fa35ab/final.json).
- [Lượt 2 final](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-cd11504b-6890-4e13-be2e-34d7bb11924a/final.json).
- [Lượt 3 final](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-04bdeab4-b9f4-4b95-b3f0-1091ff2c1ed8/final.json).
- [Summary query plan sau lượt 3](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-04bdeab4-b9f4-4b95-b3f0-1091ff2c1ed8/clickhouse-summary-plan.json).

Mỗi thư mục có manifest, admission seed/verified/timing, API summary/verified,
CPU-quota/stage snapshots, query metadata, logs, resource samples và cleanup.
Evidence dưới `tmp/` bị Git ignore; còn trên máy không đồng nghĩa có off-host backup.
