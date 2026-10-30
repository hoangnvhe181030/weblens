# Kết quả performance/load test WebLens

## Đính chính sau audit đầy đủ — 2026-10-03 02:22 giờ local (UTC+7)

**Crawler đã hoàn tất500/500execution,500.000succeeded và500.000analytics published.
Control Plane vẫn464COMPLETED/36CANCELLED,464.000succeeded/published.** Đã join
đúng500ID giữa haiDB vàlatest outbox/inbox:500eventCOMPLETED đãDELIVERED, nhưng
464APPLIED/36IGNORED_STALE; version cuối khớp Crawler. 36localCANCELLED có remote
version0. Số36“chưa bắt đầu” trước đây chỉ đúng ở projection, không đúng ở Crawler.

Crawler wall25.614,228s (10:10:05,813–17:17:00,041 UTC), throughput **19,5204
pages/s**. Số15,7160 trước đây dùng timestamps Control Plane khi apply event;
không phải throughput vật lý của worker. Terminal event delivery p955.893,59s,
max6.015,51s. Source cancellation QUEUED chuyển localCANCELLED ngay; terminal
guard chặn event muộn. Đây là lỗi tính nhất quán, không phải36crawler chưa chạy.

API/error/SLO vẫn không đạt; formal FAILED/RECOVERY_UNVERIFIED giữ nguyên.
Không coi500CrawlerCOMPLETED là bài500PASS hoặc bằng chứng1.000người liên tục.
Published counters chưa kiểm độc lập physicalClickHouse rows; global recovery
unknown. Audit không thay runtime/DDL/phát tải mới. Hồ sơ đầy đủ để đánh giá lại:
`WEBLENS_500_SCAN_REVIEW_2026-10-03.md`; CSVẩn danh/metrics/proof tại
`tmp/load/diagnosis-500-20261002/full-run-audit/`.

## Cập nhật 2026-10-02 13:43 UTC — lỗi đầu lượt và latency ổn định

Phân tích theo timestamp request metric: tất cả1.947lỗi của API500 xảy ra trong
hai phút đầu. Sau cutoff10:12:13UTC,56.428request có0lỗi nhưng p95 vẫn4.802,20ms;
scan_pages p95 5.658,81ms/mean4.611,21ms. Không bỏ startup errors, không đổi
outcome API3,0023%/p95 5.703,58ms hoặc tuyên bố đạt SLO.

Lượt crawl500 còn chạy. Progress13:41:46UTC:193COMPLETED/14RUNNING/293QUEUED,
198.784processed/500.000,2polling errors cũ,health200/UP. Đây là projection
progress giữa lượt, chưa có terminal/cleanup cuối.

Đã chuẩn bị phương án kiểm chứng tránh gọi ClickHouse cho report có expected/
published counters cùng0, giữ ownership/validation/empty array/freshness và lỗi
thật. Driver hiện có trả connection khi đọc hết rows; chưa chứng minh leak.
EXPLAIN query trên một scanQUEUED/counters0 vẫn chọn11parts/11granules sau
primary-key pruning; không thực thi report, không suy ra latency/capacity từ plan.
Người dùng đã đồng ý bước tiếp theo; chưa thay code/runtime trong lượt hiện tại.
Proof: `tmp/load/diagnosis-500-20261002/report-followup-diagnosis.json` và
`report-empty-scan-plan.json`. Automation vẫn PAUSED, không có workload chồng.

## Kết quả API 2026-10-02 10:20 UTC — lượt500 sau sửa, crawl chưa kết thúc

`worker64-500-after-claimfix`: 500/500 admission HTTP202, 500 scan ID riêng.
HTTP p95 99,55ms; client elapsed p95 3.908,15ms vẫn không đạt, TLS p95
3.660,82ms. Chưa gán nguyên nhân TLS cho client hay server.
API500VU10m kết thúc: 64.850 request, 1.947 lỗi (3,0023%), p95 5.703,58ms.
Kết quả API **không đạt**; lượt500 cũ là3,8104%/6.275,94ms.
952 lỗi login; 995 lỗi API khác gồm792 HTTP_0,202 SCAN_PAGE_NOT_FOUND,
1 CRAWLER_REPORT_UNAVAILABLE. Scan_pages421/12.675 lỗi, p95 6.772,28ms.

Đã xác nhận 52 log chờ connection ClickHouse timeout; source deploy dùng
pool10 connection chung cho report/analytics/readiness. Stage counter quanh
API window: report remote mean4.119,93ms, authorization5,73ms; login password
mean1.752,80ms. Tomcat busy median/p95100; sau API giảm2. Đây là bằng chứng
tranh chấp pool và thời gian nhánh remote, chưa kết luận query root cause
hoặc tăng pool sẽ giải quyết. System.processes bị ACCESS_DENIED497.
Log còn149 analytics/17 event acknowledgement lease stale,2 command timeout/
cancel,2 event delivery timeout; giữ lỗi và đối chiếu cleanup khi kết thúc.

Crawl còn chạy: engine568–580 claim/30s trong ba mẫu gần nhất (~19claim/s),
không claim/fetch/build/commit errors; claim không phải succeeded throughput.
Telemetry10:22:53UTC ghi24RUNNING/476QUEUED,9.471SUCCEEDED/4.318PERSISTING
trong active scope. Projection progress Control Plane10:22:08 ghi1.471processed;
các nguồn đang lệch do độ trễ, không dùng để công bố completed throughput.
Chưa có kết quả terminal/cleanup/routesoff. Wrapper30516 và sampler5444 còn
chạy lúc kiểm; API k6 đã thoát nhưng mixed-state chỉ cập nhật sau crawl.
Global DEAD/orphan PERSISTING vẫn unknown, automation PAUSED, mục tiêu1.000
còn mở; không chạy workload chồng, thay runtime hoặc shutdown.

Proof và analyzer tái lập tại `tmp/load/diagnosis-500-20261002/`:
`claimfixed500-api-analysis.json`, `claimfixed500-admission-analysis.json`,
`analyze-retry-api.py`, sampler/crawler snapshots, post-api snapshot.
Counter delta có cửa sổ bao10:10:10–10:20:22UTC; số mean không phải percentile.

Recheck10:29UTC: sampler bổ sung đã thoát cả local/remote đúng giới hạn30phút,
full JSONL/proof đã lưu. Wrapper30516 vẫn RUNNING; progress10:28:49 ghi
24RUNNING/476QUEUED,6.990processed,0terminal, ba health200/UP. Cleanup cuối
của lượt500 chưa diễn ra; không gán sampler exit thành toàn bộ run đã xong.

## Kết quả 2026-10-02 09:55 UTC — 25 tài khoản sau sửa ClaimPage

25/25 scan COMPLETED, 25.000 succeeded/0 failed pages, wall1.510,258s,
throughput16,5535 trang/s. Admission25 HTTP202, p95 HTTP192,63ms/elapsed243ms.
API25VU10m: 4.767 request, 0% errors, p95 662,14ms, k6 exit0. Queue wait
median1,77s/p95 846,20s/max1.066,87s: còn độ lệch chờ giữa các scan.
Các API dashboard/list/progress p95 khoảng19–24ms; scan_pages p95 703,78ms.

Manifest gốc FAILED_ACCEPTANCE_CRITERIA chỉ do CPU generator max91% vượt
resource gate cũ. Giữ nguyên kết quả gốc; bốn resource acceptance gates của
lượt kế tiếp đã áp dụng đúng quyền SkipOperationalGuards, số đo vẫn lưu.
Không bỏ HTTP errors, timeout, SLO hay đối chiếu identity/terminal.
25 ID riêng biệt và terminal verified, routes off, collector/test exit;
seed/DPAPI cleanup verified. Global DEAD/orphan PERSISTING vẫn unknown.
Proof: `tmp/load/phase8-worker64-claimfixed25-25x1000-20261002T092648Z/analysis.json`,
manifest/cleanup-state/global-recovery-1 trong cùng thư mục.

09:58:52 UTC đã bắt đầu thử lại `worker64-500-after-claimfix`, wrapperPID30516:
500 tài khoản ×1.000 trang, API10m, crawl tối đa8giờ, worker64/host2/delay1s.
Candidate `ceb3a767`, SHA-256 `586a1b84926579748f9dfa97e37761aee274328ed600cb44afa1a81b9e165717`.
Đây là trạng thái bắt đầu, chưa có số liệu kết quả500. Sampler read-only thêm
login/report stage và listener/thread measurements để đối chiếu API500 nếu lỗi.
Wrapper sẽ append hai báo cáo khi kết thúc; không tự chạy1.000 hoặc shutdown.

## Cập nhật 2026-10-02 09:30 UTC — nguyên nhân crawl và bản sửa đang đo

Nguyên nhân đã chứng minh: truy vấn ClaimPage lặp tra correlation cho từng
trang QUEUED trước LIMIT. Một explain sống ghi 524 lần quét inbox, execution
521,027 ms; candidate chọn một trang rồi enrichment chỉ quét inbox một lần,
20,306 ms. Không cần thêm index hoặc đổi schema. Commit sửa `ceb3a767`,
binary SHA-256 `586a1b84926579748f9dfa97e37761aee274328ed600cb44afa1a81b9e165717`;
8 nhánh workflow integration trên PostgreSQL18 local riêng passed, process đã
dừng. Mẫu query không đủ để tuyên bố capacity 500/1.000 hoặc API500 đã sửa.

Baseline `worker64-diagnostic25` đã kết thúc: 25 admission202, 1 COMPLETED,
24 CANCELLED theo hạn900s, 25 terminal, 3.779 processed theo harness;
API25VU10m 4.786 request/0% lỗi/p95 641,87ms; admission p95 430,28ms.
Outcome FAILED_ACCEPTANCE_CRITERIA; routes off, collector/test exit, seed
cleanup verified. Global DEAD/orphan PERSISTING vẫn unknown.

Đang chạy `worker64-claimfixed25` (09:26 UTC), 25 tài khoản ×1.000 trang,
API10m, hạn crawl3.600s. Ba interval đầu ổn định: 654/500/488 claim mỗi30s,
không claim/fetch/commit errors; progress09:29:17: 23 RUNNING/2 QUEUED.
Đây là tiến độ, chưa có kết quả cuối. Proof trong
`tmp/load/phase8-worker64-claimfixed25-25x1000-20261002T092648Z` và
`tmp/load/diagnosis-500-20261002/page-plan-candidate.json`.

## Chẩn đoán 2026-10-02 09:10 UTC — chưa có kết quả đạt mới

Log của lượt 500 được đối chiếu hash và phân tích tái lập tại
`tmp/load/diagnosis-500-20261002/analysis.json`. 500 cặp admission có body p95
67,03 ms và call p95 1.770,48 ms; chênh lệch chưa được tách thành chờ DB/proxy.
Caddy có 80 EOF, 186 refused connection tới 8080 trong 19:19:32–19:20:27 UTC;
không có restart Backend trong cửa sổ theo log wrapper. Analytics 12.179 batch
có median 6 trang, write 1.488 ms, acknowledgement 685 ms, total 2.316 ms.
Không có log chuyển backpressure trong cửa sổ 500. Các số liệu này không đổi
kết quả FAILED_ACCEPTANCE_CRITERIA và không chứng minh capacity 1.000.

Bài `worker64-diagnostic25` bắt đầu 09:06 UTC, 25 tài khoản × 1.000 trang,
API 10 phút, crawl tối đa 900 giây, worker 64/host slots 2/delay 1 giây giữ nguyên.
Crawler diagnostic commit `b1d1f88`, SHA-256 `a936806611dd9ba08c64a4ee67077e595ec3f9e1feb9f6e8bc8f6092f27d686d`.
Timing mặc định tắt, đã bật riêng cho bài này; không sửa dispatch/SQL.
Mẫu 30 giây đầu ổn định cho thấy 96 claim tổng 29.767 ms, fetch 549 ms,
peak active 2. Mẫu EXPLAIN eligibility read-only: planning 100,086 ms,
execution 9,277 ms; không lấy row lock và không đại diện toàn bộ claim.
Run đang chạy, chưa có acceptance/terminal cleanup cuối.
Proof: `tmp/load/phase8-worker64-diagnostic25-25x1000-20261002T090605Z`.
Global DEAD/orphan PERSISTING vẫn unknown; mục tiêu 1.000 còn mở.

## Kết quả 2026-10-02 03:23 UTC — 500 tài khoản, worker 64

Lượt `worker64-500-after-timing-retry` **không đạt**. 500/500 scan admission
HTTP 202, không có admission error; p95 HTTP 2.829,81 ms và p95 elapsed
3.374,1 ms, vượt ngưỡng 1.000 ms. API 500 VU chạy khoảng 10 phút, ghi
63.852 request, 2.433 lỗi (3,8104%), p95 6.275,94 ms và p99 10.000,40 ms.
Lỗi gồm 1.284 login và 1.149 request API khác. Trong nhóm API khác có 828
`HTTP_0`, 226 `SCAN_PAGE_NOT_FOUND` và 95 `HTTP_502`. Không coi status 0 là
latency 0 ms hoặc chuyển lỗi thành success.

Sau hạn chờ khoảng tám giờ, 81 scan `COMPLETED`, 419 `CANCELLED` qua cleanup.
Đã đối chiếu 500 scan ID duy nhất ở trạng thái terminal: 83.671/500.000 trang
processed, 82.370 succeeded, 1.301 failed. Tốc độ tính trên thời gian quan
sát là 2,8985 trang/giây; không phải throughput của workload hoàn chỉnh. API
chỉ chạy 10 phút đầu, nên không có bằng chứng 500 người dùng hoạt động liên
tục suốt crawl hoặc khả năng 1.000 người dùng.

Phân tích từng scan cho thấy chỉ 85/500 scan từng bắt đầu: 81 hoàn tất 81.000
trang, 4 bị hủy sau khi xử lý 2.671 trang; **415 scan bị hủy mà chưa bắt đầu**.
Vì vậy nguyên nhân trực tiếp của phần lớn scan không hoàn tất là chờ trong hàng
đợi đến hạn test. Tốc độ khởi chạy scan mới chỉ khoảng 6–11 scan/giờ trong các
giờ 20:00–02:59 UTC. Cần đo claim/dispatch, lease, fetch và persist để xác định
nguyên nhân gốc của tốc độ phục vụ hàng đợi; xem báo cáo thực thi.

VPS telemetry lấy mẫu CPU max 99,9%, RAM max 98,74%; guard tài nguyên đã được
người dùng bỏ và `guardReason=null`, nên đây không phải lý do harness tự dừng.
Các nguyên nhân không đạt được ghi là scan timeout, chưa hoàn tất đủ scan/trang,
5 lỗi polling và threshold admission/API. Nguyên nhân gốc của tốc độ crawl thấp
chưa được xác định. `FAILED_ACCEPTANCE_CRITERIA` trong manifest là kết quả
đánh giá; wrapper `RECOVERY_UNVERIFIED` do proof global DEAD/PERSISTING còn
thiếu, không phải bằng chứng còn scan của lượt này.

Phân tích cửa sổ API từ telemetry lấy mẫu: Tomcat busy median 99/p95 100
threads, Hikari pending 0; chưa xác định thread đang chờ gì. Sau API, 1.723
mẫu VPS có median 456 scan QUEUED, 3 RUNNING và 1.621 page QUEUED; p95
leased pages/active host leases chỉ 1. Lease ngắn có thể không xuất hiện trong
mẫu, nên đây là hướng điều tra dispatcher/lease/fetch/persist, chưa phải kết
luận nguyên nhân. Tham chiếu phương pháp và giới hạn ở báo cáo thực thi.

Lúc 03:23:38 UTC, active scan/execution và backlog trong phạm vi đã đo bằng 0,
routes off, sáu service Running và ba health HTTP 200/body UP. Logger admission
đã trả về mặc định lúc 03:28:31 UTC, Backend health UP. Nguồn chi tiết:
`tmp/load/phase8-worker64-500-after-timing-retry-500x1000-20261001T190749Z/manifest.json`,
`500-scans/cleanup-scans.json`, `cleanup-state.json`, `global-recovery-1.json`
và `tmp/load/phase8-worker64-500-after-timing-retry-logger-restore.json`.

## Cập nhật 2026-10-01 19:08 UTC — lượt 500 mới đang chạy

Sau khi người dùng cho phép bỏ backup, cổng recovery và guard tài nguyên
riêng lượt này, wrapper `worker64-500-after-timing-retry` bắt đầu 19:07:43 UTC:
500 tài khoản × 1.000 trang + API, worker 64, admission logger DEBUG.
State mới là `RUNNING`; chưa có số latency, error, throughput hay kết quả
terminal. Giữ mọi lỗi và cleanup thật. Nguồn theo dõi:
`tmp/load/phase8-scheduled-state-worker64-500-after-timing-retry.json`.

## Cập nhật 2026-10-01 18:56 UTC — lượt chạy lại dừng ở preflight

Run label `worker64-500-admission-measurement` chỉ chạy preflight: kết quả
`PREFLIGHT_BLOCKED`, **không tạo tải**. Ba health preflight HTTP 200/body UP,
routes off, nhưng global recovery còn hai phạm vi DEAD/PERSISTING unknown.
Sau khi trả logger về mặc định, verifier 18:55:46 UTC ghi Backend HTTP 200,
hai worker curl timeout 5 giây và RAM 82,94%; không bỏ qua failure này.
Ngoại lệ skip backup/guard riêng lượt mới đang chờ câu trả lời. Vì chưa có
admission hay mixed API mới nên chưa có số p95, lỗi, throughput hoặc trang.
Proof `tmp/load/postdeploy-admission-measurement-20261002.json`.

## Cập nhật 2026-10-01 18:43 UTC — Backend đã deploy, chưa chạy lại 500

Candidate timing admission `56b0660` đã deploy riêng Backend, hash production
`924db7d2cf9930cb32cde21c3d503846ee6c04cbeecaad8ae3222ed05c8d8326`.
Postdeploy health ba service HTTP 200/body UP, sáu service Running, routes off,
backlog trong scope đã đo 0; global recovery vẫn chưa xác minh DEAD/PERSISTING.
Trước deploy có hai health curl timeout 5 giây, giữ nguyên như failure.

**Chưa phát lượt tải 500 mới**, chưa có admission/API p95, error rate, số trang
hoặc throughput mới. Logger stage production chưa bật DEBUG. `mvnw verify` ở
candidate: 87 tests đạt, 19 integration tests SKIPPED do Docker; patch manager
smoke 5/5 đạt. Ngoại lệ bỏ backup/guard cho lượt mới đang chờ câu trả lời riêng.
Proof và rollback provenance: `tmp/load/postdeploy-admission-measurement-20261002.json`.
Logger admission DEBUG đã bật và Backend health HTTP 200/body UP lúc 18:51 UTC;
chưa có request tải mới. Hai identity unresolved được đọc lại đúng owner lúc
18:51:58 UTC, lịch sử vẫn 0 và credentials tiếp tục được giữ.

## Cập nhật 2026-10-01 18:08 UTC — sửa local và đối chiếu timeout, chưa chạy lại

Đối chiếu lượt `20261001T093718Z`: hai timeout có status 0, HTTP duration 0,
connecting khoảng 1.031 ms, chưa có send/wait/receive. Caddy trong 09:45–09:51 UTC
ghi 498 admission POST, tất cả 202; p95 proxy 2.032,68 ms. Không thấy POST của hai
website còn thiếu trong cửa sổ này. Phù hợp với lỗi thiết lập kết nối trước request
được ghi log; nguyên nhân cụ thể chưa xác định. HTTP duration 0 không là latency
0 ms, không chứng minh DB rollback hoặc scan không tồn tại.

Đã sửa local số đo elapsed cho mọi admission attempt, diagnostic transport,
correlation UUID xuyên client/Backend và thêm chế độ tiếp tục các scan đã xác minh.
Trong chế độ opt-in, các tài khoản chưa có scan vẫn dùng API dashboard/list/history;
manifest ghi rõ số scan xác minh/unknown, lỗi admission và threshold vẫn khiến
workload không đạt. Mặc định strict giữ nguyên; timeout không nới, POST không retry.
Instrumentation Backend cho stage/transaction completion chưa deploy.

| Xác minh local | Kết quả |
| --- | --- |
| Backend service/timing | 10/10 tests đạt, gồm commit thất bại sau body thành công. |
| k6 offline | Timeout elapsed, correlation, một POST/attempt, 500 API users với 498 scan, strict/duplicate refusal đạt. |
| Harness offline | Windows PowerShell 5.1 và PowerShell 7 đạt: partial continuation, reconciliation, owner, cleanup, telemetry/EXPLAIN gates. |
| Primary diagnostic | Lỗi gốc giữ nguyên qua recovery; secret không xuất hiện; đạt. |
| Source hygiene | UTF-8/diff check đạt. |

Không có lượt tải mới, số throughput mới hoặc bằng chứng cải thiện production.
Mixed API của lượt cũ vẫn `NOT_STARTED`; 498 CANCELLED và hai identity unresolved
giữ nguyên. Chế độ API mới vẫn 10 phút, không đáp ứng phép đo liên tục suốt crawl
cho Phase 6. Chi tiết tại `PERFORMANCE_OPTIMIZATION_EXECUTION.md` mục 18:08 UTC;
artifacts `tmp/load/phase8-after-auth-report-connection-diagnostic-20261001.json`
và `tmp/load/performance-admission-harness-validation-20261001.json`.

## Cập nhật 2026-10-01 09:57 UTC — lượt 500 sau deploy không đạt

Run `worker64-500-after-auth-report` đã kết thúc: 498/500 admission được quan
sát, hai identity chưa xác minh commit, p95 admission 2.062,00 ms (ngưỡng
1.000 ms). Mixed API chưa bắt đầu vì admission không được xác minh, nên chưa có
kết quả API 500 người sau deploy. 498 scan được thu hồi và xác nhận `CANCELLED`;
5.308 trang processed trước khi dừng. Hai lịch sử scan đúng owner/website đọc
lại lúc 09:57 UTC đều rỗng, nhưng chưa chứng minh không thể commit muộn; private
seed được giữ. Không công bố throughput/capacity của workload hoàn chỉnh.

Routes synthetic off; ba health HTTP 200/body UP và backlog trong scope đo 0
lúc 09:51:35 UTC. Global recovery vẫn chưa xác minh hai scope DEAD/PERSISTING.
Evidence: `tmp/load/phase8-worker64-500-after-auth-report-500x1000-20261001T093718Z/manifest.json`,
`cleanup-state.json`, `admission-reconciliation-followup.json`,
`500-scans/submission-summary.json` và `global-recovery-1.json`.

## Cập nhật 2026-10-01 09:37 UTC — lượt tải 500 mới đang chạy

Sau khi người dùng cho phép bỏ backup và guard riêng lượt này, wrapper
`worker64-500-after-auth-report` đã bắt đầu với worker 64 và 500 tài khoản ×
1.000 trang + API. State lúc 09:38 UTC là `RUNNING`; chưa có số admission,
latency API, số trang hoàn tất hoặc kết quả cuối. Giữ mọi lỗi và SLO thật.
Nguồn theo dõi: `tmp/load/phase8-scheduled-state-worker64-500-after-auth-report.json`
và `tmp/load/phase8-worker64-500-after-auth-report-500x1000-20261001T093718Z`.

## Cập nhật 2026-10-01 09:34 UTC — bản sửa đã deploy, chưa có lượt tải mới

Backend/Frontend từ commit riêng `9042d075acbb0dfaf06217c0c5802038b93520a6`
đã được triển khai trên nền release production. Hai mẫu postdeploy 09:33:10 và
09:33:30 UTC: ba health HTTP 200/body UP, routes synthetic off, active scan và
active execution trong scope đo bằng 0, RAM 66,40%/66,50%. Backend hash mới
`34b486d53d09ad11594f264f2ec7f69f1d6cc289acdff0bd5ed909dc0ce09074`;
Frontend index hash mới
`26857dafc509a49b95e545a322b22ad4b0160426e22af017bbd23ddb37c52e0d`.
PostgreSQL IT 4/4 đạt trên PG18.4 local biệt lập; PostgreSQL 17 production chưa
được dùng cho IT.

Preflight lượt 500 mới dừng với `PREFLIGHT_BLOCKED` trước khi phát tải:
`globalRecoveryVerified=false` vì `DEAD` outbox và `PERSISTING` ngoài active
executions chưa được xác minh. Không có số latency/throughput/error mới để so với
lượt trước. Artifacts: `tmp/load/postdeploy-auth-report-polling-20261001.json`,
`tmp/load/phase8-scheduled-state-worker64-500-after-auth-report.json` và
`tmp/load/phase8-worker64-500-after-auth-report-preflight-1.json`.

## Cập nhật 2026-10-01 07:05 UTC — kiểm thử sửa local, chưa có kết quả tải mới

Đã sửa transaction login/report, metrics theo stage, adaptive polling UI và giữ
primary error của harness. Chi tiết phạm vi và semantics tại
`PERFORMANCE_OPTIMIZATION_EXECUTION.md`, mục 07:05 UTC.

| Phần xác minh | Kết quả |
| --- | --- |
| Backend package | 78 unit/security/architecture tests đạt, build thành công. |
| Focused verify sau assertion/IT mới | 14 auth/report tests đạt; 4 PostgreSQL IT SKIPPED do Docker daemon không hoạt động. |
| Frontend | 36 tests đạt; focused 7 tests sau sửa cuối đạt; build/lint đạt. |
| Diagnostic/harness offline | Hai shell đạt; mô phỏng 500 identities, không admission/crawl/SQL production. Failure không bị recovery ghi đè hoặc xóa sau success. |
| Source hygiene | UTF-8/diff check đạt; bảo toàn thay đổi có sẵn. |

Đây là kiểm thử correctness/boundary, không phải performance benchmark. Chưa deploy,
chưa đo cải thiện p95/capacity hoặc xác nhận 500.000 trang. Production metrics/counter
gần nhất thuộc proof pool 32 lúc 06:18 UTC, không thuộc code local này. Kết quả FAILED
của lượt 500 và giới hạn cửa sổ API 10 phút giữ nguyên; Phase 3–6 chưa hoàn tất.

## Cập nhật 2026-10-01 06:18 UTC — cấu hình pool 32 đã áp dụng, chưa test tải mới

Theo yêu cầu trực tiếp, đã đổi Backend Hikari max 10 → 32/minIdle 2 → 4 và
PostgreSQL runtime role limit 15 → 40. Restart riêng Backend; metrics sau restart
xác nhận **max 32/min 4**, Java PID mới, Tomcat max 100 và binary hashes gốc.
Worker crawl vẫn 64/host 2. Metadata budget cluster max100/reserved3/other finite
role limits40 để lại 17 slot ngoài các budget đã phân bổ; không phải capacity.

Health startup UP, probe riêng 06:17:30 curl exit0/HTTP200/bodyUP, sáu service
Running. Những probe trong giai đoạn startup chưa sẵn sàng được giữ trong proof.
Counter timeout 0 thuộc process mới, không so trực tiếp với counter 251 trước
restart để tuyên bố cải thiện. Chưa chạy workload mới hoặc xác nhận SLO 500 người.
Kết quả FAILED của lượt 500 trước giữ nguyên.

Evidence: `tmp/load/phase4-backend-pool32-change.json` và
`tmp/load/phase4-backend-pool32-followup.json`. Env rollback copy với ACL bảo vệ
chỉ ở VPS; không backup DB hoặc đổi schema/grants/index. Syntax/UTF-8 và metrics/
PID/hash/health verification đạt. Global recovery vẫn unknown; review index và
Phase 3–6 còn mở.

## Cập nhật 2026-10-01 06:07 UTC — ngân sách trước khi tăng pool

Probe metadata Control Plane PostgreSQL chỉ đọc xác nhận max_connections=100,
3 superuser reserved slots, role Backend connection limit=15, database limit=-1.
Do đó chỉ đổi Hikari max từ 10 lên 32/64 chưa đủ; phải xem xét riêng role limit
và các client cùng cluster. Đây là catalog/config hiện tại, không phải kết quả
performance hoặc proof global recovery. Chưa đổi env/DB role, restart hoặc chạy
lượt mới. Nguồn: `tmp/load/phase4-backend-pool-budget.json`.

## Cập nhật 2026-10-01 05:30 UTC — điều tra lỗi lượt 500

Đã xác nhận một nguyên nhân lỗi API: **Backend không lấy được connection DB**.
Log 03:57:51.830 UTC ghi pool total=10/active=10/idle=0/waiting=90, timeout
5128 ms; Hibernate ném `CannotCreateTransactionException`, handler trả HTTP 500.
249 dòng timeout acquire trong cửa sổ log không phải số request k6 bị lỗi.
Runtime/metrics xác nhận Backend pool max 10, Tomcat max threads 100; worker
crawl 64/host 2 là cấu hình riêng.

Caddy GET tiến độ của một scan đã admission trả HTTP 500; correlation ID khớp
Backend `ScanService.get` timeout acquire 5450 ms (10 active/0 idle/71 waiting).
Harness throw khi polling không trả 200 và finally hủy scan. Đây là bằng chứng
mạnh cho đường dừng test; exception gốc local vẫn mất do wrapper recovery ghi
đè, và timestamp generator/server khác nhau chưa có proof lệch clock lịch sử.
Không kết luận client timeout 10 giây là exception fatal từ thời lượng tổng.

610 page-report 404 tập trung trong phút đầu cleanup; contract có cả nhánh
owner scan không thấy và Crawler report execution không thấy. Chưa có log phân
biệt từng 404; command delivery chậm là giả thuyết, không phải kết luận. Giữ
907 failures và p95 7189,67 ms. Cửa sổ API trùng cleanup, crawl vẫn không hoàn
thành 500000 trang; không có capacity/throughput toàn workload để công bố.

Artifact lược bỏ dữ liệu nhạy cảm: `tmp/load/phase4-500-failure-diagnosis.json`,
gồm hash nguồn log, correlation match, configuration allowlist và giới hạn
bằng chứng. Check offline scan ID/admission và correlation/stack đạt. Không
thực hiện SQL/tải mới/thay cấu hình/sửa harness hoặc production. Chưa đo riêng
thời gian giữ transaction do login bcrypt/report HTTP/SQL/background work.
Global recovery unknown, review index pending và Phase 3–6 chưa hoàn tất.

## Cập nhật 2026-10-01 04:40 UTC — kết quả lượt 500: không đạt

Lượt `20261001T035026Z`, worker 64/host 2, không backup/guard tài nguyên theo
yêu cầu trực tiếp. **Crawl không hoàn thành 500.000 trang**: harness ghi FAILED
03:57:52 UTC rồi cleanup/hủy scan; exception gốc bị wrapper recovery ghi đè nên
chưa xác định nguyên nhân. Không gán lỗi cho RAM guard, DB hoặc một patch.

| Phần đo | Kết quả |
| --- | --- |
| Tạo scan | 500/500 HTTP 202, lỗi 0%, p95 1.750,27 ms; không đạt threshold admission 1.000 ms. |
| API 500 VU/10 phút | 55.707 HTTP requests, 907 lỗi (1,63%), p95 7.189,67 ms, p99 8.125,22 ms, gồm login. Không đạt SLO p95 300 ms/error dưới 1%. Cửa sổ này trùng cleanup, không phải crawl 500 scan hoàn chỉnh. |
| Terminal sau follow-up | 500/500: 499 CANCELLED, 1 PARTIAL_SUCCESS; 0 COMPLETED. |
| Trang thực đối chiếu | 10.721 processed, 2.269 succeeded, 8.452 failed; không có throughput toàn workload để công bố. |
| Tài nguyên mẫu VPS | RAM max 75,20%, CPU max 76,4%; không chứng minh đỉnh giữa mẫu hoặc nguyên nhân lỗi. |

API đọc không gồm login: 55.041 request/741 lỗi, gồm 610 SCAN_PAGE_NOT_FOUND,
57 INTERNAL_ERROR, 74 HTTP_0. Login 666 request/166 lỗi. Không bỏ lỗi 404 để đạt
gate. Follow-up đúng owner lúc 04:33:46 thấy scan cuối đã PARTIAL_SUCCESS, chỉ
login/GET, không cancellation mới hoặc replay scan POST.

Hiện wrapper đã thoát, các scan đã terminal và routes off. Active/backlog trong
scope đã đo 0; proof 04:34 có hai worker curl timeout, probe độc lập 04:37 curl
cả ba HTTP 200/body UP. Không coi recheck là stability hoặc global proof:
DEAD/orphan PERSISTING vẫn chưa đo. Không chạy lượt mới, restore worker, deploy,
DDL hoặc shutdown. Phases tối ưu 3–6 vẫn chưa hoàn tất.
Đã lưu proof và xóa private seed/password DPAPI sau đối chiếu terminal đủ 500;
mọi public/raw artifact giữ nguyên.

Kết quả có raw đối chiếu:
`tmp/load/phase8-worker64-500-no-guards-retry-500x1000-20261001T035026Z/outcome-followup.json`.
Chi tiết endpoint/cleanup/giới hạn ở
[PERFORMANCE_OPTIMIZATION_EXECUTION.md](PERFORMANCE_OPTIMIZATION_EXECUTION.md).

## Cập nhật 2026-10-01 03:59 UTC — đã bắt đầu tải 500 scan và API

Lượt `20261001T035026Z`: **500/500 admission HTTP 202**, 500 scan ID riêng biệt,
admission error **0%**, p95 tạo scan **1.750,27 ms**. K6 admission exit 99 do
p95 vượt threshold 1.000 ms; không đổi failure thành success. Theo user waiver
vẫn tiếp tục workload. API **500 VU** bắt đầu **03:57:42 UTC**, chạy 10 phút.

Crawl 500 scan × 1.000 trang vẫn đang chạy; chưa có số trang cuối, throughput
hoặc p95 mixed API. ACK không chứng minh crawl hoàn tất hoặc capacity 500.
Production worker 64/host 2, binaries gốc. Không backup/guard resource tự dừng
theo yêu cầu trực tiếp; giữ thu số đo và terminal/route cleanup.

Evidence: `tmp/load/phase4-500-started-evidence.json`; run directory:
`tmp/load/phase8-worker64-500-no-guards-retry-500x1000-20261001T035026Z`.
Wrapper PID 21812 đang chạy nền; global recovery vẫn chưa xác minh.

## Cập nhật 2026-10-01 03:50 UTC — lượt đầu lỗi setup, đang chạy lại bước chuẩn bị

Lượt `20261001T033711Z`: đã tạo 500 tài khoản/website; k6 setup timeout 120 giây
sau 298 login request. Không có admission metric/observation hoặc scan trong
history của 500 website đã đối chiếu; API/crawl chưa chạy. Admission latency 0
trong summary là **không có mẫu**, không dùng làm kết quả performance. Wrapper/
collectors đã kết thúc, routes off; recovery global vẫn chưa xác minh.

Tăng riêng giới hạn chuẩn bị login 500 lên 10 phút, giữ timeout request 5 giây,
maxDuration admission 30 giây và SLO/thresholds. Dùng lại seed 500 tài khoản/
website/password DPAPI; không tạo 500 tài khoản mới hoặc replay POST scan.
Lượt sau PID 21812 bắt đầu 03:50:20 UTC, label
`worker64-500-no-guards-retry`. Bỏ backup/operational guard theo yêu cầu trực tiếp.
Chưa có kết quả tải; trạng thái ở `tmp/load/phase4-500-active-run.json`.

## Cập nhật 2026-10-01 03:37 UTC — khởi động lượt 500 theo yêu cầu bỏ guard

Theo yêu cầu trực tiếp mới "không cần backup hay guard, hãy chạy cho tôi", đã
khởi động wrapper PID 33996, label `worker64-500-no-guards`, với 500 tài khoản ×
1.000 trang và 500 VU API/10 phút, worker 64/host 2. Không backup, không pre-load
global/resource/telemetry gate hoặc auto-stop theo RAM/CPU/health. Giữ đối chiếu
identity/owner/terminal cleanup, timeout/SLO và thu số đo. Không sửa runtime/DB.

Chưa có kết quả hoàn tất, chưa xác nhận số scan thực tạo. Global recovery trước
tải còn unknown; review index chưa duyệt. Nhánh waiver đã kiểm thử offline, gồm
truyền option vào mock harness và tắt route sau chạy; unknown vẫn được ghi đúng.
Nguồn trạng thái: `tmp/load/phase4-500-active-run.json` và
`tmp/load/phase8-scheduled-state-worker64-500-no-guards.json`.

## Cập nhật 2026-10-01 03:29 UTC — bài test 500 chưa bắt đầu

Đã nhận yêu cầu 500 tài khoản riêng biệt × 1.000 trang, kèm 500 VU dùng API;
worker production 64/host 2. Tổng workload dự kiến 500.000 trang. Harness,
wrapper, k6 và analyzer đã nhận mức 500. Kiểm thử offline 150 và 500 identities
đạt, gồm 29 committed timeout giả lập, owner-safe reconciliation/cancellation,
terminal cleanup, gate chặn trước route và giữ credentials mã hóa DPAPI khi
cleanup chưa xác minh. k6 inspect xác nhận 500 VU. Đây là validation công cụ,
không phải kết quả test 500 người trên WebLens.

Preflight cụ thể 03:29:17: ba health HTTP 200/body UP, sáu service Running,
RAM 67,96%, browsers 0, hai routes off, binaries gốc, backlog trong scope đã đo
0. **PREFLIGHT_BLOCKED**, `globalRecoveryVerified=false`: event outbox DEAD và
PERSISTING ngoài active executions chưa đo. Không phát tải, seeding, đổi route,
service hoặc DB. Review index revision 1 vẫn đang chờ; không hỏi lại hoặc tự duyệt.
Probe 03:18 có hai worker timeout vẫn giữ trong artifact, chưa rõ nguyên nhân.

Chưa có số p95/throughput/error/capacity cho 500 người. API dự kiến cửa sổ 10
phút, nghỉ 3 giây sau request như baseline; không đủ thay thế Phase 6 API suốt
crawl. Trước chạy còn cần recovery, guard trong admission và giữa vòng polling
500 scan, telemetry và backup mới. Chi tiết ở
[PERFORMANCE_OPTIMIZATION_EXECUTION.md](PERFORMANCE_OPTIMIZATION_EXECUTION.md).
Proof: `tmp/load/phase8-worker64-500-preflight-1.json`; trạng thái:
`tmp/load/phase8-scheduled-state-worker64-500.json`. Automation tiếp tục PAUSED.

## Cập nhật 2026-10-01 02:59 UTC — cấu hình worker 64

Theo yêu cầu mới, production Crawler đã đổi từ 20 lên **64 worker**, host vẫn 2.
Chỉ thay một dòng env và restart Crawler, có backup/hash/rollback; không deploy
patch code hoặc chạy benchmark. Hai mẫu trước đổi đạt readiness/RAM dưới 85%;
hai mẫu sau đổi ba health UP, RAM 69,47%/69,31%, sáu service Running, routes off,
browsers 0, không workload/backlog trong phạm vi đã đo. PID Crawler mới đã xác minh.
Artifact public: `tmp/load/phase4-worker64-change.json` (`APPLIED_HEALTHY`).

Đây **không phải kết quả hiệu năng ở 64 worker**: chưa đo throughput/API p95,
before/after hoặc capacity mới. Baseline 15,89 trang/s và API p95 674,83 ms
vẫn thuộc cấu hình 20 worker. Global recovery còn thiếu event DEAD/orphan
PERSISTING, review DB chưa trả lời; không chạy tải tiếp hoặc tắt máy. Automation
đã PAUSED trước thao tác này và tiếp tục giữ trạng thái đó. Các kết quả lịch sử
bên dưới giữ nguyên ngữ cảnh thời điểm đo.

Ngày cập nhật: 2026-09-30. **Lượt 75 scan × 1.000 trang đã hoàn tất 75.000/75.000
trang trên fixture synthetic ở 7,90 trang/giây; lượt 50 scan trước đó hoàn tất
50.000/50.000 trang ở 12,25 trang/giây. Đây là hai workload khác nhau trên
production, chưa xác định breaking point. Tối ưu receipt giảm stage tra receipt
mỗi trang 94,11%.**
Chỉ ghi số đo sau khi phase tương ứng có môi trường, raw artifact và kiểm chứng.

## Phase 1 — Kiểm kê và kế hoạch

Hoàn tất. Xem [PERFORMANCE_LOAD_TEST_PLAN.md](PERFORMANCE_LOAD_TEST_PLAN.md).
Đã xác định trần runtime, khác biệt giữa VU/scan/page/browser, quota ba scan mỗi
user, giới hạn host hai slot và thiếu metrics production. SLO API p95 300 ms,
p99 1 giây, lỗi bất ngờ dưới 1% là giả thuyết để đo, chưa phải cam kết.

## Phase 2 — Harness và preflight

Trạng thái: **hoàn tất và đã được người dùng review trước khi chạy baseline**.

| Mục | Kết quả |
| --- | --- |
| Môi trường đích | Người dùng chọn VPS production đang phục vụ `jobnext.top`; SSH cũ được xác minh bằng thao tác chỉ đọc. |
| VPS | Windows Server 2019, 8 logical processor, khoảng 7,00 GiB RAM; production đã deploy commit `f873c77903965b4d6c9ad2498969d594e7b01401`. |
| Cấu hình effective | Hikari 10; Tomcat 100 thread; scan tối đa 1.000 trang/concurrency 20; crawler 20 slot, host 2; Capture 1, site clone 1; Camoufox. |
| Nguồn đích synthetic | `jobnext.top` resolve trực tiếp tới IP VPS. Fixture được mở rộng để chạy dưới prefix riêng; runner tính đúng health path theo prefix. |
| Kiểm thử local | `node tools/load/smoke-test.mjs` đạt: 40 yêu cầu API giả lập và một crawl fixture 40 trang qua runner. Đã sửa lỗi fixture để mọi path ngoài prefix trả 404, kể cả health/robots; smoke kiểm tra link và canonical vẫn nằm trong prefix. k6 2.2.0 nằm ở `C:\Program Files\k6\k6.exe`; archive/cú pháp và phép thử chặn remote không xác nhận đều đạt. Chưa chạy k6 trên WebLens thật. |
| Dữ liệu production | Fixture 1.000 trang chạy bằng Windows service manual-start `WebLensFixture`, tài khoản ảo `NT SERVICE\WebLensFixture`, chỉ bind `127.0.0.1:19090`. Identity/website benchmark riêng đã chạy đúng một scan và capture trang lá; chi tiết nằm dưới. |
| Backup | Backup mới ngay trước baseline đã tạo cho cả ba PostgreSQL tại commit production hiện tại, tải ra `tmp/load/offhost-backups/performance-preflight-20260927T164814Z`, kiểm SHA-256 và `pg_restore --list` đều đạt. Restore drill trước đó có source/target counts giống hệt nhau; recovery ClickHouse/R2 vẫn phụ thuộc provider. |
| Metrics | Actuator metrics đã deploy, thiếu token trả 401 và token đúng đọc được 117 metric. Collector v2 production thu được JVM/memory/GC/thread, Hikari, Tomcat thread, HTTP, ba PostgreSQL và hai ClickHouse; smoke chống rò secret đạt trên local và VPS. |
| Route công khai | Đã bật đúng prefix bằng Caddy. Kiểm chứng ngoài VPS: health trả JSON `UP` với 1.000 trang; trang 999 trả đúng HTML fixture 4.096 byte, không redirect, TLS hợp lệ; POST trả 405. Hai path ngoài prefix trả frontend SPA và không chứa dữ liệu fixture. |
| Lưu ý deploy | Mỗi release thay junction `C:\WebLens\current`, nên route fixture tạm thời phải được bật lại sau deploy. Sau commit cuối, script route đã validate/restart/kiểm tra lại thành công: fixture và route đều khỏe, public path bị cô lập, 1.000 trang. |

Gói ban đầu đã triển khai có SHA-256
`52AE75EB947CBF4F5138052B8C2B91BB558D2796CD0B305D99EE737FFE9E0831`. Gói v3 tại
`tmp/load/weblens-performance-fixture-phase2-v3.zip` có SHA-256
`127692AC402D110F0B373E56FF6977D11C18F28FCA034FD5304881F4DDD00E6F`; gói thêm
Windows service tạm thời dùng `NT SERVICE\WebLensFixture` và script quản lý route.
Script route sao lưu Caddyfile, validate, restart `WebLensCaddy`, kiểm tra nội dung
JSON/trang fixture công khai và tự hoàn tác nếu kiểm tra thất bại. Caddy 2.11.4
trên VPS đã validate cấu hình đề xuất; route hiện đã được áp dụng lại sau release
cuối và status đạt toàn bộ kiểm tra.

Lần `enable` đầu tiên dừng trước khi restart vì Windows PowerShell diễn giải log
`info` trên stderr của `caddy validate` thành `NativeCommandError`. Nhánh catch đã
khôi phục Caddyfile gốc. Kiểm tra sau lỗi xác nhận `WebLensCaddy` vẫn chạy, route
công khai vẫn trả frontend, fixture service vẫn khỏe và chạy bằng
`NT SERVICE\WebLensFixture`. Script được sửa để quyết định theo exit code của
Caddy trong khi vẫn giữ output chẩn đoán. Hotfix v4 tại
`tmp/load/weblens-fixture-route-hotfix-v4.zip` có SHA-256
`F2C4DF0465C8B8367E62809F923701DCB7E23A92D5B0050945C22189553CC775`.

Preflight production dùng trang lá `/__weblens-load/page/999` để scan đúng một
trang trước khi tăng tải. Script tạo/đăng nhập identity benchmark riêng bằng mật
khẩu nhập ẩn, sau đó đối chiếu scan terminal, report fresh, page 200 thành công,
capture terminal, snapshot khớp page/capture và JPEG artifact. Report không ghi
email hoặc credential. Ở mốc gói v5, mock E2E trên Windows đã đạt toàn bộ luồng
và xác nhận report không chứa token/mật khẩu; production sau đó đã chạy và hoàn
tất như phần preflight bên dưới.
Gói `tmp/load/weblens-phase2-preflight-v5.zip` có SHA-256
`EC0F6BC5EBDBB3C29C486C6C627508544DA59422346C934C9A69FC3B37F68407`.

Lần chạy production đầu tiên dừng trước authentication vì script gọi
`https://jobnext.top/actuator/health`; Caddy phục vụ frontend HTML tại path này
thay vì proxy backend. Không có identity, website, scan hoặc capture được tạo.
Kiểm tra tiếp theo xác nhận Control Plane, Crawler và Capture đều trả `UP` qua
loopback. Script được sửa để kiểm tra riêng ba endpoint loopback trước khi dùng API
công khai.
Gói sửa `tmp/load/weblens-phase2-preflight-v6.zip` có SHA-256
`4FD456DA5D01B28A90DAE03A425783B4DCF8419002EC64931F27C2E608DEC33A`.

Lần chạy v6 đã tạo và hoàn tất scan/capture một trang, sau đó dừng khi tải JPEG:
client gửi `Accept: application/json` nên API trả 406. Log Capture xác nhận capture
`c8a68416-9fef-408f-956b-26713319da8d` đã staged với một network request và
reconstruction `PUBLISHED`. Bản sửa gửi `Accept: image/jpeg` và có chế độ
`-ResumeLatest` để đối soát chính scan/capture này mà không tạo workload thứ hai.
Gói `tmp/load/weblens-phase2-preflight-v7.zip` có SHA-256
`4BFCB7EEBE8E85A10E3BE47583E8A245CAB3CB9224FF2521C2BDE8528988EAB0`.

Preflight production cuối cùng hoàn tất và được đối chiếu từ raw report
`preflight-20260927T150643Z.json`. Cả ba service trả `UP`; scan
`bb18a147-b168-43b8-a933-c15a72721f0e` hoàn tất 1/1 trang trong 2.344 ms, report
fresh, trang trả HTTP 200 trong 67 ms với 4.096 byte. Capture
`c8a68416-9fef-408f-956b-26713319da8d` hoàn tất trong 39.563 ms bằng Camoufox
152.0.4-beta.28; JPEG 27.073 byte có SHA-256
`9b3c98d51e7b66ca43b77e75f2d2514b98f6cf79f222d83d522f17fd7d53cf75`.
Reconstruction đóng gói 1/1 trang, trạng thái `PUBLISHED`, completeness
`COMPLETE`, archive 5.309 byte. Đây là bằng chứng E2E chức năng, không phải số đo
capacity hoặc browser throughput.

### Bảng thu số liệu cho lần đo đầu tiên

Chỉ dùng các nguồn sau khi quyền đọc, thời gian lấy mẫu và chỗ lưu raw artifact đã
được kiểm chứng. Mẫu thống nhất UTC mỗi 5 giây, chụp ít nhất 60 giây trước tải,
toàn bộ tải và 5 phút hồi phục. Gắn run ID ở tên artifact, không gắn URL, email,
token hoặc scan ID vào nhãn metric. Máy phát tải và fixture phải có mẫu CPU/RAM
riêng để loại trừ bão hòa nguồn phát/nguồn trang.

| Chỉ số | Nguồn và cách đối chiếu | Trạng thái |
| --- | --- | --- |
| API p50/p95/p99, lỗi, req/s, dropped iterations | k6 JSON theo endpoint và toàn workload; lưu cả cấu hình, thời gian, số VU, SLO và status code. | Kịch bản có; chưa chạy WebLens thật. |
| CPU/RAM, disk, network, process/browser count | `tools/load/collect-windows.ps1` ghi CPU/RAM, disk/network I/O, TCP state, service, process CPU/I/O/thread/handle/working set và browser process count. Máy k6 dùng cùng collector. | Smoke local/VPS và mẫu production đạt. |
| JVM heap/GC/thread, Hikari active/idle/pending | Actuator metrics chỉ qua loopback, yêu cầu `X-WebLens-Service-Token`; collector bỏ toàn bộ tag để không xuất URI/ID. | Đạt production: 401 khi thiếu token, 200 khi token đúng; có JVM memory, năm GC metric, JVM thread, mười Hikari metric, ba Tomcat thread metric và HTTP server metric. Public Caddy không trả catalog metrics. |
| Ba PostgreSQL: connection, wait/lock, transaction và query latency | Collector dùng `pg_stat_activity`, `pg_stat_database`, `pg_locks`, timeout 2 giây và không xuất query text. Production là PostgreSQL 17.11; cả ba role đọc được aggregate. `pg_stat_statements` chưa bật nên query latency chi tiết ghi `extension-disabled`; WAL chưa có quyền/nguồn riêng. | Đạt trong JSONL production. |
| Active/queued scan, pages/s, retry và queue age | Snapshot tổng hợp `scans`, `crawl_executions`, `scan_pages`, host lease và outbox. Retry được tính từ phần attempt vượt lần đầu; pages/s lấy delta page terminal giữa hai mẫu. | Truy vấn production đạt; preflight không để queue tồn. |
| Browser workers, capture queue/retry, artifact | Tổng hợp `capture_jobs`, `site_reconstruction_*`, outbox, `page_snapshots`; đối chiếu browser process trên host. | Truy vấn và process discovery đạt; số đo dưới tải sẽ lấy ở phase browser capacity. |
| ClickHouse và object storage | Hai role ClickHouse tách biệt đọc row counter của đúng database. Snapshot production: crawl 1.420 page metrics/ingestion receipts, 2.581 findings, 44.701 links; capture 1 rendered page/1 request/1 receipt, 0 resource body. | JSONL cuối thu đủ hai nguồn trong 369 ms và 110 ms. Có một lần kết nối tạm thời timeout, cần theo dõi khi baseline. R2 provider request/error/latency chưa có nguồn; ghi `N/A`, chỉ đối chiếu reference byte/object từ Capture PostgreSQL. |

Collector Windows ghi JSONL UTF-8, từ chối ghi đè file cũ và không đọc command
line của tiến trình. Chỉ khi có `-ProductionTelemetry`, nó đọc tệp environment
được bảo vệ trong bộ nhớ để xác thực tới các nguồn telemetry; URL kết nối,
credential, token và SQL không được serialize. Smoke bằng secret giả đạt. CPU
tiến trình là thời gian tích lũy; phải lấy delta giữa hai mẫu, chia cho thời gian
và số logical processor để ra CPU %. Quyền cho các truy vấn PostgreSQL/ClickHouse
đã được kiểm chứng; vòng JSONL production sau deploy metrics đã chạy thành công.

Restore drill PostgreSQL `postgres-migration-20260927-125717` đã được đối chiếu:
11 bảng Control Plane, 14 bảng Crawler và 13 bảng Capture có source/target count
giống từng byte. Ba dump lần lượt 369.150, 781.430 và 178.959 byte; SHA-256 khớp
manifest sau khi sao chép ra khỏi VPS. Đây là bằng chứng restore cho snapshot lúc
migration, không thay thế backup mới trước baseline và chưa chứng minh recovery
cho ClickHouse Cloud hoặc R2.

Gói collector/backup cuối tại `tmp/load/weblens-phase2-telemetry-v8b.zip` có
SHA-256 `33DDE90E513E0EF552A0E9BDE62AA5F99257BB955765918C747470454D4F90BC`.
Gói đã triển khai trên VPS và smoke test đạt. Nó chứa collector production,
smoke test chống rò secret, script backup ba PostgreSQL và README; không chứa
environment file hay credential. Mẫu production cuối nằm tại
`C:\ProgramData\WebLens\performance-fixture\runtime\telemetry-preflight-20260927T164747Z.jsonl`.

Backup trước baseline `performance-preflight-20260927T164814Z` gắn đúng commit
`f873c77903965b4d6c9ad2498969d594e7b01401`. Ba dump `weblens`,
`weblens_crawler`, `weblens_capture` lần lượt có kích thước 372.477, 776.723 và
181.572 byte; checksum trong manifest khớp bản sao ngoài VPS và cả ba TOC đọc
được bằng `pg_restore --list`.

Các truy vấn quan sát production phải chỉ đọc, có `statement_timeout` ngắn, không
quét HTML/payload hoặc xuất dữ liệu cá nhân. Khi một metric thiếu, không suy nó từ
CPU hay từ kết quả k6; cột đó để `N/A`, và không kết luận bottleneck tương ứng.

### Production preflight và rào chắn

VPS được người dùng chọn là production. Web chưa công khai không làm thay đổi việc
máy vẫn phục vụ domain và lưu dữ liệu thật. Chỉ mở route chính xác cho prefix
synthetic, giữ prefix khi reverse proxy, giới hạn phương thức và xác minh ngoài
prefix không bị fixture xử lý. Fixture trực tiếp trả 404 ngoài prefix, còn Caddy
tiếp tục phục vụ frontend hiện có; reverse proxy phải giữ nguyên prefix (`handle`,
không dùng `handle_path` của Caddy). Không đổi chính sách SSRF. Fixture bind loopback và chạy bằng tài
khoản ít quyền. Trước E2E cần xác nhận đường đi từ Crawler và Capture tới hostname
synthetic, fixture không redirect ra ngoài, và không có URL bên thứ ba trong scan.

Trước tải lớn phải chụp backup PostgreSQL mới và sao chép ra ngoài VPS; restore
drill ba database đã đạt trên snapshot migration. Vẫn phải xác minh phương án
khôi phục ClickHouse/R2, dung lượng còn lại và thời gian phục hồi. Đặt ngưỡng dừng cho CPU/RAM/disk, lỗi API,
queue age, retry và sức khỏe dịch vụ dựa trên baseline; giám sát cả thời gian hồi
phục. Bài đầu chỉ một scan/capture nhỏ bằng tài khoản riêng, kết thúc và đối soát
page/report/artifact rồi mới cân nhắc tăng tải. Raw artifact giữ ngoài kho Git;
dữ liệu benchmark chỉ dọn sau khi đã đối chiếu kết quả.

Tại điểm đóng Phase 2, chưa chạy baseline hoặc tối ưu runtime và
`READY_FOR_PHASE_3_BASELINE = YES`. Người dùng sau đó đã review, cho phép chạy
baseline; kết quả nằm ở Phase 3 dưới đây. Các bậc API lớn, crawler concurrency,
large scan, stress, spike, browser capacity và soak vẫn chưa chạy.

### Điều kiện hoàn tất Phase 2

1. Đạt: fixture synthetic chạy bằng tài khoản ảo ít quyền, route prefix riêng và
   chỉ trỏ đến tài nguyên do mình kiểm soát.
2. Đạt: test identity/website riêng; scan và capture một trang hoàn tất, đã đối
   chiếu report/page/JPEG/reconstruction.
3. Đạt: collector thu được CPU/RAM/process/browser, Actuator, ba PostgreSQL,
   ClickHouse, queue/retry và ghi rõ R2 provider telemetry là `N/A`.
4. Đạt: backup mới đã sao chép ra ngoài VPS và kiểm checksum/TOC; restore drill
   ba PostgreSQL trước đó đạt. Đã đến điểm dừng để người dùng review Phase 2.

## Phase 3 — Baseline production

Trạng thái: **hoàn tất; dừng tại review gate trước Phase 4**.

Lượt hợp lệ có run ID `20260928T040938Z`, release
`f873c77903965b4d6c9ad2498969d594e7b01401`. Raw artifact nằm ngoài Git tại
`tmp/load/phase3-20260928T040938Z`; `manifest.json`, sáu k6 summary/JSONL,
telemetry generator/VPS, scan/capture report và `analysis.json` đều đã được đối
chiếu. Diagnostic loopback được lưu ở `crawler-report-direct.json`. Summary k6
đã bỏ `setup_data`; kiểm tra lại không còn access token. Không
có email hoặc mật khẩu benchmark trong manifest/report.

### Môi trường và workload

| Thành phần | Cấu hình đã đo |
| --- | --- |
| Máy phát k6 | Windows 11 Pro 10.0.26200; AMD Ryzen 7 PRO 6850HS, 8 core/16 logical processor; 33.622.609.920 byte RAM; k6 2.2.0. |
| VPS production | Windows Server 2019 Datacenter 10.0.17763; 8 vCPU Intel Xeon Gold 6133; 7.515.635.712 byte RAM. |
| Control Plane | Temurin JRE 21.0.12.1, `-Xms256m`, `-Xmx1280m`; Tomcat max 100 thread; Hikari max 10 connection. |
| Dữ liệu | Một identity/website riêng; fixture 1.000 trang, fanout 10, delay 2 ms, body 4.096 byte; chỉ URL dưới `/__weblens-load/`. |
| API baseline | Warm-up 1 VU/30 giây; ba lượt 1 VU và ba lượt 10 VU, mỗi lượt 60 giây, nghỉ 10 giây giữa lượt. Mỗi vòng đọc 5 endpoint bằng cùng một account. |
| Scan/capture | Một scan bounded bắt đầu tại trang 9, graph đúng 100 trang; sau đó một capture cùng trang. |
| Thu thập | Local và VPS trong 15 phút, recovery 5 phút. Khoảng lấy mẫu thực tế median là 7,10 giây trên generator và 16,48 giây trên VPS do thời gian chạy các probe, dù interval cấu hình là 5 giây. |

### API baseline

Số dưới đây là median của ba lượt. `req/s` là `http_reqs` của k6 nên gồm hai
request setup cho mỗi lượt; số request đọc loại trừ setup.

| VU | Request đọc | req/s | p50 | p95 | p99 | Lỗi |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 535 | 2,956 | 21,3 ms | 605,6 ms | 620,1 ms | 0% |
| 10 | 5.085 | 27,195 | 19,1 ms | 774,7 ms | 886,9 ms | 0% |

Tăng từ 1 lên 10 VU làm throughput tăng khoảng 820%, trong khi p95 toàn workload
tăng 27,9%. Cả sáu lượt đều vượt giả thuyết SLO p95 < 300 ms, nhưng nguyên nhân
tập trung ở một endpoint:

| Endpoint | 1 VU p95 / p99 | 10 VU p95 / p99 |
| --- | ---: | ---: |
| `dashboard_summary` | 26,8 / 55,2 ms | 26,5 / 37,5 ms |
| `website_list` | 37,6 / 72,0 ms | 31,1 / 48,0 ms |
| `scan_list` | 31,5 / 43,0 ms | 31,4 / 45,9 ms |
| `scan_progress` | 26,4 / 37,6 ms | 28,3 / 42,0 ms |
| `scan_pages` | 627,6 / 733,2 ms | 891,3 / 1.011,8 ms |

Bốn API Control Plane thông thường đạt p95 < 300 ms. `scan_pages` chiếm 20% mix
và làm p95 tổng vượt SLO ngay ở 1 VU. Với Phase 4, giữ SLO p95 < 300 ms và p99 <
1 giây cho bốn endpoint thông thường; đề xuất tách SLO ban đầu của report
`scan_pages` thành p95 < 1 giây, p99 < 1,5 giây và lỗi < 1%. Đây là SLO để phát
hiện regression/capacity, không phải lý do bỏ qua việc tối ưu report.

### Scan và browser capture đơn

| Chỉ số | Kết quả |
| --- | ---: |
| Scan | `COMPLETED`, 100 discovered/processed/succeeded, 0 failed |
| Thời gian scan quan sát | 55,736 giây |
| Throughput scan | khoảng 1,79 trang/giây |
| Queue crawler | tối đa 86 trang; oldest queued age tối đa 36,644 giây; về 0 khi kết thúc |
| Retry trong cửa sổ đo | page/crawler analytics/crawler event: 0 |
| Capture | `COMPLETED` trong 27,153 giây; JPEG 38.079 byte; reconstruction `PUBLISHED`/`COMPLETE` |
| Browser process | tối đa 7, về 0 sau capture |

Đây chỉ là service time của một scan và một capture. Nó chưa phải crawler hoặc
browser capacity vì chưa có concurrency.

### Tài nguyên, DB và phục hồi

| Chỉ số | Kết quả |
| --- | --- |
| Generator | CPU p95 11,65%, max 26%; RAM dùng max khoảng 16,38 GiB/31,31 GiB. Không bão hòa nguồn phát. |
| VPS | Toàn lượt CPU p95 26,96%, max 47,6%; RAM dùng max khoảng 5,31 GiB/7,00 GiB; disk queue luôn 0. |
| VPS theo API | 1 VU: CPU median/max 7,85/8,8%. 10 VU: 22,6/30,1%. RAM dùng max khoảng 5,09 GiB ở 10 VU. |
| JVM/GC | `jvm.memory.used` max khoảng 370 MiB; 11 GC pause với tổng 0,268 giây; GC overhead max 0; live thread max 28. |
| Pool/thread | Hikari active max 6/10, pending 0, timeout tăng 0; Tomcat busy max 8/100. |
| PostgreSQL | Active connection max Control/Crawler/Capture lần lượt 1/2/5; lock wait 0, deadlock tăng 0, temp byte tăng 0. `pg_stat_statements` chưa bật nên query latency chi tiết là `N/A`. |
| ClickHouse probe | 55/55 mẫu available. Crawl query median/p95/max 301/372/527 ms; Capture 111/119/132 ms. Đây là probe tổng hợp, không phải timing từng query của API. |
| Object storage | Provider latency/error vẫn `N/A`; chỉ có reference counter từ Capture PostgreSQL. |
| Recovery 5 phút | CPU VPS median 5,4%, disk p95 1%, active scan 0, queued page 0, browser process 0. Ba service health trả 200/UP, fixture vẫn 1.000 trang, API ẩn danh 401 và release commit không đổi. |

### Bottleneck đầu tiên có bằng chứng

Điểm chậm đầu tiên là **đường đọc analytical report của Crawler cho
`GET /api/v1/scans/{scanId}/pages`**. Bằng chứng:

1. Ở 1 VU, `scan_pages` p50/p95 là 599,4/627,6 ms; bốn endpoint còn lại có p95
   26,4–37,6 ms.
2. Gọi trực tiếp Crawler qua loopback, bỏ Caddy/TLS/Control Plane, 10 request cùng
   report cho p50 587,0 ms và p95 599,1 ms. Gần toàn bộ độ trễ nằm sau boundary
   Crawler.
3. Code hiện tại đọc report state từ PostgreSQL rồi chạy tuần tự `ListPages`,
   `listFindingsForPages` và `ScanSummary` trên ClickHouse. Probe ClickHouse crawl
   riêng có median 301 ms.
4. Trong cùng cửa sổ, CPU, JVM, Hikari, Tomcat và PostgreSQL không cạn; không có
   lock, timeout hoặc lỗi HTTP.

Kết luận đủ chắc để khoanh vùng Crawler analytical report/chuỗi query ClickHouse,
nhưng chưa đủ để quy một query cụ thể vì production chưa có timing từng query.
Không thay đổi query, index, cache hoặc concurrency trong Phase 3. Trước tối ưu,
cần thêm timing cho ba bước hoặc benchmark từng query; sau đó chỉ thay một nguyên
nhân và chạy lại đúng workload ba lượt.

### Ghi chú thực thi và giới hạn

- Lần khởi động đầu dừng trước workload vì Crawler readiness tạm trả 503; hai lần
  kiểm tra kế tiếp và toàn lượt hợp lệ đều 200/UP. Chưa có đủ mẫu để gọi đây là
  sự cố tải.
- Một lượt bị loại đã hoàn tất scan/capture nhưng warm-up k6 gửi 0 request do k6
  2.2.0 không có global `URL`. Harness được sửa bằng phép tách hostname tương
  thích và archive/cú pháp đạt trước lượt hợp lệ.
- Collector nền VPS ban đầu bị Windows OpenSSH kết thúc cùng phiên SSH. Launcher
  cuối giữ phiên collector suốt lượt đo và có cleanup khi lỗi.
- Collector bắt đầu ngay trước scan nên không có 60 giây idle trước tải. Recovery
  cung cấp 21 mẫu idle sau tải; đây là baseline hồi phục tương đương, nhưng các
  spike ngắn hơn interval thực tế 16,48 giây có thể bị bỏ sót.
- Workload dùng một account chung và tối đa 10 VU. Không suy số distinct users,
  capacity hoặc saturation từ Phase 3.

`READY_FOR_PHASE_4_API_LOAD = YES`, sau khi người dùng review Phase 3 và chấp
nhận SLO tách riêng cho `scan_pages`. Phase 4 bắt đầu ở 50 VU với stop guard tài
nguyên/queue và không nhảy thẳng đến bậc cao hơn.

## Phase 4 — API load production

Trạng thái: **hoàn tất tại stop guard 50 VU; dừng tại review gate trước Phase 5**.

Lượt hợp lệ có run ID `20260928T051717Z`, cùng release và dataset của Phase 3.
Raw artifact nằm ngoài Git tại `tmp/load/phase4-20260928T051717Z`; gồm manifest,
k6 summary/JSONL, telemetry generator/VPS, seed report và `analysis.json`. Workload
dùng một account/token chung, 50 VU chạy tuần tự năm API đọc, nghỉ một giây sau
mỗi vòng. Vì vậy, VU ở đây là mức đồng thời của workload, không phải số người dùng
phân biệt.

### Kết quả 50 VU

| Cửa sổ | Thời lượng cấu hình | Request đọc | req/s | p50 | p95 | p99 | Lỗi |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Warm-up | 30 giây | 2.370 | 70,254 | 371,0 ms | 1.203,5 ms | 1.504,0 ms | 0% |
| Plateau | 60 giây | 4.785 | 75,022 | 345,1 ms | 1.105,5 ms | 1.455,3 ms | 0% |

`req/s` là `http_reqs` của k6 và gồm hai request setup. Warm-up và plateau đều
vượt cùng nhóm SLO, nên đây không phải nhiễu riêng của một cửa sổ. Chi tiết
plateau:

| Endpoint | p50 | p95 | p99 | SLO đạt? |
| --- | ---: | ---: | ---: | --- |
| `dashboard_summary` | 332,1 ms | 761,2 ms | 938,6 ms | Không, p95 |
| `website_list` | 256,4 ms | 571,7 ms | 745,4 ms | Không, p95 |
| `scan_list` | 264,0 ms | 672,8 ms | 872,3 ms | Không, p95 |
| `scan_progress` | 247,2 ms | 724,7 ms | 1.205,6 ms | Không, p95 và p99 |
| `scan_pages` | 927,5 ms | 1.430,6 ms | 1.896,3 ms | Không, p95 và p99 |

So với median baseline 10 VU, throughput chỉ tăng 175,9% khi số VU tăng 400%;
p50 tăng 1.709,7%, p95 tăng 42,7% và p99 tăng 64,1%. Không có lỗi HTTP, nhưng
độ trễ và hiệu suất mở rộng đã không còn đạt SLO.

### Tài nguyên, pool và phục hồi

| Chỉ số | Kết quả |
| --- | --- |
| Generator | CPU max 8%; RAM dùng max 46,43%. Nguồn phát không bão hòa. |
| VPS | CPU max 29,4%; RAM dùng max 71,19%. Không bão hòa CPU/RAM. |
| JVM/GC | `jvm.memory.used` max khoảng 358 MiB; 12 GC pause, tổng 0,209 giây; GC overhead max 0,038%; live thread max 68. |
| Hikari | Active max 10/10, idle min 0, pending max 28; timeout tăng 0. Pending đã về 0 ở mẫu đầu sau request cuối, không muộn hơn 1,174 giây. |
| Tomcat | Busy max 39/100, current max 50; chưa chạm trần thread. |
| PostgreSQL | Active query max Control/Crawler/Capture là 2/1/1; lock wait 0, deadlock tăng 0, temp byte Control tăng 0. Query latency chi tiết vẫn `N/A` vì `pg_stat_statements` chưa bật. |
| ClickHouse probe | Crawl median/p95/max 308/397,7/432 ms; Capture 113/121,6/123 ms. Đây là probe tổng hợp. |
| Queue/retry/browser | Không tạo scan trong phase này; active scan, queued page và mọi retry delta đều 0; browser process cuối là 0. |
| Recovery 90 giây | Control Plane, Crawler và Capture trả HTTP 200; fixture `UP`; API ẩn danh 401; queued page và browser process bằng 0. |

### Biên capacity đã đo và stop guard

Stop guard dừng ngay ở bậc 50 VU vì k6 fail SLO và Hikari có request chờ. Các
bậc 100, 250, 500 và 1.000 VU không chạy để tránh đẩy production qua một mức đã
biết là không bền vững.

- Mức cao nhất đã đo và đạt SLO: **10 shared VU**.
- Mức đầu tiên đã đo và không đạt: **50 shared VU**.
- Khoảng 11–49 VU chưa đo; chưa thể nêu một con số capacity chính xác hơn.
- Chưa đo distinct-user workload, nên không quy đổi thành 10 hay 50 người dùng.

### Bottleneck đầu tiên và nguyên nhân ứng viên

Tại 50 VU, Hikari đạt 10/10 và pending 28 trong khi PostgreSQL Control Plane chỉ
có tối đa hai query active, CPU VPS 29,4%, Tomcat busy 39/100 và lỗi HTTP 0%.
Điều này cho thấy connection đã checkout bị giữ trong lúc request chờ thành phần
khác, thay vì PostgreSQL đang thực thi đủ mười query.

`ScanReportService` hiện đặt `@Transactional(readOnly = true)` ở cấp class.
`listPages` đọc user/scan từ PostgreSQL rồi gọi đồng bộ sang Crawler trước khi
method và transaction kết thúc. Crawler tiếp tục chạy tuần tự phần đọc state,
`ListPages`, findings và `ScanSummary`; direct Crawler baseline p50 khoảng 587 ms.
Nguyên nhân ứng viên mạnh nhất là transaction quá rộng giữ Hikari connection qua
độ trễ Crawler/ClickHouse. Đây là kết luận từ tương quan telemetry và code path;
chưa có tracing theo request để chứng minh thời gian giữ từng connection.

Thay đổi có chủ đích đề xuất cho phase tối ưu là kết thúc phần DB authorization
trước outbound Crawler call, không tăng pool trước. Sau thay đổi phải chạy lại đúng
50 VU warm-up/plateau và baseline ba lượt để tính before/after. Chưa áp dụng tối
ưu nào trong Phase 4.

`READY_FOR_PHASE_5_CRAWLER_LOAD = YES`, sau khi người dùng review Phase 4. Việc
tối ưu API được giữ lại cho phase before/after sau khi các baseline cần thiết đã
được đo.

## Phase 5 — Crawler load production

Trạng thái: **hoàn tất tại rào chắn tài nguyên trước bậc 50 scan; dừng tại review
gate trước Phase 6**.

Các lượt hợp lệ dùng cùng release
`f873c77903965b4d6c9ad2498969d594e7b01401`. Raw artifact nằm ngoài Git tại:

- `tmp/load/phase5-20260928T080429Z`: bậc 1 và 5 scan.
- `tmp/load/phase5-20260928T081801Z`: lượt xác nhận sạch bậc 10 scan.
- `tmp/load/phase5-20260928T082634Z`: bậc 25 scan.
- `tmp/load/phase5-analysis-20260928/analysis.json`: kết quả hợp nhất.

Mỗi scan dùng một tài khoản, website và hostname synthetic riêng dưới wildcard do
người dùng kiểm soát. Cách này đo concurrency giữa các scan mà không bị giới hạn
hai slot cho cùng host làm sai mục tiêu. Mỗi hostname chỉ phục vụ
`/__weblens-load/*` qua HTTP tới fixture loopback; mọi path khác trả 404. Mỗi scan
có graph đúng 100 trang, fanout 10, delay 2 ms và body 4.096 byte. Route wildcard
tạm đã được tắt sau đo; route fixture chính HTTPS vẫn khỏe với 1.000 trang.

### Kết quả crawler concurrency

| Scan đồng thời | Accepted/terminal | Trang | Wall time | Throughput | Admission p95 | Scan median | Scan p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 100 | 55,523 giây | 1,8011 trang/giây | 102,3 ms | 55,522 giây | 55,522 giây |
| 5 | 5/5 | 500 | 113,136 giây | 4,4195 trang/giây | 105,1 ms | 113,001 giây | 113,022 giây |
| 10 | 10/10 | 1.000 | 214,531 giây | 4,6613 trang/giây | 99,2 ms | 213,796 giây | 213,972 giây |
| 25 | 25/25 | 2.500 | 527,294 giây | 4,7412 trang/giây | 202,9 ms | 503,778 giây | 524,672 giây |

Tất cả scan hợp lệ đều `COMPLETED`, 100% trang thành công và retry delta bằng 0.
Từ 1 lên 5 scan, throughput tăng 145,38%. Từ 5 lên 10, throughput chỉ tăng 5,47%
trong khi scan median tăng 89,20%. Từ 10 lên 25, throughput chỉ tăng thêm 1,71%
trong khi scan median tăng 135,64%. Vì vậy:

- Mức cao nhất đã đo bền vững: **25 concurrent scans**.
- Plateau throughput đầu tiên đã đo: **10 concurrent scans**.
- Breaking point: **chưa đo được**.
- Bậc 50 scan không được gửi vì RAM production trước tải không xuống dưới rào
  chắn 80%; bậc 75 và 100 không chạy vì bậc 50 chưa qua pre-load gate.

Không được diễn giải 25 là giới hạn tối đa của crawler. Đây chỉ là cận dưới đã đo
trong workload 100 trang/scan và cấu hình production hiện tại.

### Bottleneck đầu tiên có bằng chứng

Bottleneck đầu tiên là **throughput của đường persist/deliver analytics trong
Crawler**. Evidence chính:

1. Ở 10 scan, queued page đạt tối đa 715, `PERSISTING` đạt 723 và analytics
   pending đạt 623; fetch queue đã về 0 lúc `08:20:21Z`, nhưng active scan chỉ về
   0 lúc `08:22:51Z`.
2. Ở 25 scan, queued page đạt tối đa 1.410, `PERSISTING` đạt 2.093 và analytics
   pending đạt 1.993; fetch queue về 0 lúc `08:29:38Z`, nhưng active scan chỉ về
   0 lúc `08:37:04Z`.
3. Số analytics record claimed cùng lúc chạm đúng 100 ở các bậc 5, 10 và 25.
   Worker hiện là một vòng xử lý gọi `ClaimAnalytics(..., 100, ...)`; poll interval
   mặc định là 500 ms tại `crawler/internal/analytics/worker.go` và
   `crawler/internal/config/config.go`.
4. Throughput gần như phẳng ở 4,4195 → 4,6613 → 4,7412 trang/giây, trong khi độ
   trễ mỗi scan tăng mạnh và fetch queue đã rỗng trước khi scan hoàn tất.

Đây là bằng chứng mạnh để khoanh vùng analytics persistence/delivery. Chưa có
benchmark timing riêng cho từng thao tác insert/ack ClickHouse, nên chưa kết luận
một câu lệnh cụ thể là nguyên nhân cuối cùng. Phase này không thay batch size,
poll interval hoặc số worker.

### Tài nguyên, DB và phục hồi

| Chỉ số | Kết quả |
| --- | --- |
| Generator | Ở 25 scan: CPU max 33%, RAM dùng max 57,52%. Nguồn phát không bão hòa. |
| VPS | Ở 25 scan: CPU max 47,8%, RAM dùng max 88,55%. CPU chưa bão hòa; RAM là rào chắn để không gửi bậc 50. |
| JVM/GC | Ở 25 scan: heap metric dùng max khoảng 404,6 MiB/2,48 GiB metric max; 10 GC pause, tổng 0,173 giây; GC overhead max 0,041%; live thread max 36. |
| Hikari/Tomcat | Hikari active max 1/10, pending 0, timeout tăng 0; Tomcat busy max 2/100. Control Plane không phải điểm nghẽn của workload crawler này. |
| PostgreSQL | Active connection max Control/Crawler/Capture là 2/3/2; có một mẫu lock wait ở Control nhưng không có deadlock. `pg_stat_statements` vẫn tắt nên query latency chi tiết là `N/A`. |
| ClickHouse probe | Ở 25 scan, crawl query median/p95/max là 313,5/358,2/387 ms. Đây là probe tổng hợp, không phải timing insert/ack của analytics worker. |
| Queue/retry | Sau recovery, active scan, active execution, queued page, persisting page và analytics pending/claimed đều về 0; page, analytics và event retry delta của mỗi lượt hợp lệ đều 0. |
| Dịch vụ | Control Plane, Crawler, Capture và fixture đều trả 200/`UP`; browser process bằng 0; release commit không đổi. |

RAM không trở lại dưới 80% sau bậc 25 và bước seed chuẩn bị bậc 50, dù toàn bộ
queue đã sạch và dịch vụ khỏe. Harness ghi lượt `phase5-20260928T083934Z` là
`STOPPED_BEFORE_LOAD`; 50-scan workload chưa hề được submit.

### Lượt chẩn đoán bị loại

- `phase5-20260928T080429Z/10-scans` chỉ accepted 8/10 vì hai request admission
  timeout ở 5 giây. Hệ thống tự hồi phục; lượt xác nhận độc lập sau đó accepted và
  hoàn tất 10/10, nên chỉ lượt xác nhận được dùng trong bảng.
- Các lượt trước đó dừng ở health/pre-load gate hoặc lỗi helper của harness không
  được dùng để tính capacity. Một lượt một scan có RAM pre-load 90,58% cũng bị
  loại để tránh baseline bẩn.

`READY_FOR_PHASE_6_LARGE_SCAN = YES`, sau khi người dùng review Phase 5. Phase 6
phải bắt đầu bằng large scan có rào chắn tài nguyên; chưa tối ưu analytics trước
khi hoàn tất các baseline cần thiết.

## Phase 6 — Large scan trên production

Trạng thái: **hoàn tất lượt 1.000 và 10.000 trang**. Dừng tại review gate trước
phase tiếp theo; không dùng các lượt bị hủy để tính capacity.

Trước khi chạy đã backup mới cả ba PostgreSQL và tải bản sao ra máy local tại
`tmp/load/offhost-backups/performance-preflight-20260928T091312Z`; SHA-256 và TOC
được đối chiếu. Cùng release
`f873c77903965b4d6c9ad2498969d594e7b01401`, fixture synthetic do mình kiểm
soát, fanout 10, delay 2 ms, body 4.096 byte. VPS Windows Server 2019 có 8 vCPU,
RAM khoảng 7 GiB; mỗi scan có effective concurrency 20, Crawler 20 slot
toàn cục và 2 slot/host. Không gửi tải tới website bên thứ ba.

### Lượt 1.000 trang hợp lệ

Raw artifact: `tmp/load/phase6-20260928T094636Z-1000-pages`. Scan
`18adcb09-92d9-467f-8aff-dbdb07a3a005` trả `COMPLETED`, đúng 1.000/1.000
trang thành công, 0 trang lỗi. Effective config xác nhận `maxPages=1000`, depth 4,
concurrency 20. Runner chạy **548,464 giây**, throughput đầu cuối **1,8233
trang/giây**. Mốc này bao gồm admission, crawl, persist và chờ trạng thái terminal;
không phải tốc độ riêng của fetch worker.

| Chỉ số | Kết quả |
| --- | --- |
| API runner | 111 request thành công, 0 lỗi; p50/p95/p99 là 61/104/169 ms. Đây là request điều khiển và polling, không phải latency từng trang. |
| VPS | CPU max 25%; RAM dùng max 68,53%; host lease max 2. |
| Queue | `QUEUED` max 888 trang; `PERSISTING` max 10; analytics pending/claimed max 5/6. Tất cả về 0 sau recovery. |
| JVM/DB | GC tăng 5 pause, tổng 0,128 giây; Hikari pending max 0. Query latency chi tiết chưa có vì `pg_stat_statements` tắt. |
| Retry/browser | Page, analytics và event retry delta đều 0; browser process max 0. |

### Lượt 10.000 trang không hợp lệ để tính capacity

Production và fixture được tạm nâng lên 10.000 trang; health và effective config
đều xác nhận giới hạn này. Lượt `phase6-20260928T101147Z-10000-pages`, scan
`0f05bedb-4104-44b8-b673-cdb3f2ed37e6`, chạy tới 1.577 trang thành công.
Phiên giám sát local bị ngắt khi scan còn chạy; scan sau đó được hủy có chủ đích
qua API. Trạng thái cuối trong database là `CANCELLED` với 8.423 trang bị hủy.
Telemetry VPS đã sao chép về cùng thư mục artifact: CPU max 32,5%, RAM max
66,86%, `QUEUED` max 8.881 trang trong cửa sổ quan sát. Các số này chỉ mô tả
lượt dở dang; không suy ra thời gian hoàn tất hoặc saturation point 10.000 trang.
Một lượt 10.000 trước đó bị loại ngay vì Backend cũ vẫn dùng giới hạn 1.000.

Script hoàn nguyên ban đầu chờ Backend health 30 giây, quá ngắn cho lần restart
production này. Sau khi tăng thời gian chờ lên 120 giây, hoàn nguyên thành công:
`WEBLENS_SCAN_MAX_PAGES=1000`, fixture config/health cùng 1.000 trang, state tạm
đã xóa. Control Plane, Crawler, Capture và fixture trả `UP`; release không đổi;
active scan/execution, queued page, host lease, analytics pending và browser
process đều bằng 0. RAM dùng 64,05% ở mẫu hậu kiểm. Route HTTPS trả fixture
health 1.000 trang và trang 999 đúng 4.096 byte; path ngoài prefix vẫn là
frontend. Không có tối ưu runtime nào được áp dụng trong Phase 6.

### Lượt 10.000 trang hợp lệ

Trước lượt cuối, backup mới cả ba PostgreSQL được tải ra local tại
`tmp/load/offhost-backups/performance-preflight-20260928T113245Z`; SHA-256 và
`pg_restore --list` đạt. Tác vụ Windows độc lập giữ runner và guard hoạt động khi
phiên điều khiển ngắt, tự hoàn nguyên production sau khi thu telemetry. Một lượt
trước đó bị 401 do access token hết hạn sau 15 phút đã được hủy và hoàn nguyên;
runner được sửa để đăng nhập lại trước khi token hết hạn. Lượt đó không tính vào
benchmark.

Raw artifact hợp lệ: `tmp/load/phase6-20260928T113419Z-10000-pages`, gồm
`manifest.json`, `runner-report.json`, telemetry generator/VPS và guard. Scan
`dfb15eff-b36a-413e-93bd-e7de3160f7ba` trả `COMPLETED`, đúng
**10.000/10.000 trang thành công**, 0 trang lỗi. Effective config xác nhận
`maxPages=10000`, depth 4, concurrency 20. Runner đăng nhập lại 6 lần, chạy
**5.718,569 giây** (95,31 phút), throughput đầu cuối **1,7487 trang/giây**.
Thời gian này gồm admission, crawl, persist và chờ trạng thái terminal; không phải
tốc độ riêng của fetch worker. Fixture do mình kiểm soát có fanout 10, delay 2 ms
và body 4.096 byte.

| Chỉ số | Kết quả |
| --- | --- |
| API runner | 1.121 request thành công, 0 lỗi/timeout; p50/p95/p99 là 61/202/574 ms. Đây là request điều khiển và polling, không phải latency từng trang. |
| VPS | CPU max 33,1%; RAM dùng max 69,32%; host lease max 2/2. Ba health endpoint luôn trả 200 trong guard. |
| Queue | `QUEUED` max 8.879 trang, `PERSISTING` max 60; analytics pending/claimed max 27/52. Các queue và host lease đều về 0 ở mẫu cuối. |
| JVM/DB | JVM memory used max khoảng 362 MiB; GC tăng 40 pause, tổng 1,220 giây; Hikari active max 1/10, pending 0; PostgreSQL active max Control/Crawler/Capture là 2/3/3. Query latency chi tiết vẫn `N/A` vì `pg_stat_statements` tắt. |
| Retry/browser | Page, analytics và event retry delta đều 0; browser process trên VPS max 0. Đây không phải benchmark browser worker. |
| Máy phát tải | CPU median/p95/max 7/54/100%; RAM dùng median/p95/max 61,97/86,55/92,52%. Có các đỉnh tài nguyên cục bộ, nên không quy đổi lượt này thành capacity tổng quát. |
| Recovery | Telemetry tiếp tục 180 giây sau scan; Control Plane, Crawler, Capture khỏe, queue/lease bằng 0. |

Tác vụ kết thúc `COMPLETED_RESTORED`. Kiểm tra trực tiếp sau đó xác nhận
`managed=false`, `WEBLENS_SCAN_MAX_PAGES=1000`, fixture config/health cùng 1.000
trang, Backend và fixture khỏe. Route HTTPS trả health 1.000 trang; release
`f873c77903965b4d6c9ad2498969d594e7b01401` không đổi. Lượt 10.000 chỉ
chứng minh **một scan 10.000 trang hoàn tất** dưới workload và cấu hình này;
không xác định được số concurrent large scans, saturation hay breaking point.
Không có tối ưu runtime trong Phase 6, nên không có số liệu before/after.

### Preflight ngày 2026-09-29: 50 tài khoản × 1.000 trang

Yêu cầu mới là 50 tài khoản riêng, mỗi tài khoản gửi một scan 1.000 trang đồng
thời, tổng workload dự kiến 50.000 trang trên 50 hostname synthetic riêng. Bài
đo **chưa được gửi tải** vì VPS production không đạt rào chắn tài nguyên trước
load (`RAM < 80%` ở hai mẫu liên tiếp). Ba mẫu trực tiếp lúc
04:44:23/04:45:29/04:46:45 UTC cho thấy RAM dùng lần lượt
87,84%/88,84%/88,26%; RAM trống khoảng 0,85/0,78/0,82 GiB. CPU tương ứng
45,75%/38%/38,38%. Release vẫn là
`f873c77903965b4d6c9ad2498969d594e7b01401`; giới hạn production và fixture
đều 1.000 trang, Backend/fixture khỏe, route hostname synthetic vẫn tắt. Không
tạo tài khoản, website hay scan cho lượt này.

Lượt 25 scan × 100 trang trước đó đã chạm 88,55% RAM, nên không ngoại suy nó
thành khả năng chạy 50 scan × 1.000 trang. Khi production trở lại dưới rào chắn,
cần chạy bằng harness có timeout phù hợp với 50.000 trang, guard hủy scan nếu
dịch vụ hoặc tài nguyên vượt ngưỡng, và đối chiếu 50 trạng thái terminal trước
khi công bố capacity. **Tại thời điểm preflight này chưa có số liệu 50 user crawl
đồng thời.**

## Bài đo bổ sung 2026-09-29 — 50 tài khoản × 1.000 trang

Trạng thái: **đã gửi tải, dừng bởi guard; chưa chứng minh 50 scan hoàn tất**.
Mỗi tài khoản riêng có một website synthetic trên hostname riêng và gửi đúng một
scan. VPS vẫn chạy release `f873c77903965b4d6c9ad2498969d594e7b01401`, giới
hạn 1.000 trang/scan. Backup mới của ba PostgreSQL đã tải ra local tại
`tmp/load/offhost-backups/performance-preflight-20260929T091746Z`; dung lượng,
SHA-256 và TOC đều khớp. Route hostname synthetic được tắt sau lượt chạy.

Lượt đầu `tmp/load/phase7-50x1000-20260929T091118Z` **không hợp lệ để tính
capacity**: harness trỏ trang bắt đầu tới `/__weblens-load/page/0`, trong khi
fixture đặt trang 0 ở `/__weblens-load/`. 50/50 scan được nhận rồi `FAILED` sau
một trang trả 404 mỗi scan. Đã sửa URL và kiểm tra trang gốc trả HTTP 200 trước
khi chạy lại.

Lượt chạy lại có raw artifact tại
`tmp/load/phase7-50x1000-20260929T091943Z`. API nhận **50/50 scan**; admission
p50/p95 là 190,1/276,1 ms, k6 không báo lỗi admission. Đến khoảng 09:40 UTC,
guard yêu cầu hủy vì Crawler readiness thất bại. Trong cửa sổ thu mẫu, VPS CPU
max 66,2%, RAM dùng max 49,56%; Hikari pending max 0, timeout delta 0; retry
page/analytics/event delta đều 0. Peak active scan/execution là 50/50. Collector
ghi 8.523 trang mới ở trạng thái `SUCCEEDED` trước khi kết thúc cửa sổ thu mẫu,
nhưng **không có 50 scan terminal thành công** nên không tính pages/sec capacity.

Crawler `/health/live` trả 200 nhưng `/health/ready` trả 503. Code readiness kiểm
tra analytics outbox `PENDING`/`CLAIMED`/`DEAD` cũ hơn ngưỡng mặc định 15 phút;
production không override ngưỡng này. Telemetry tại thời điểm dừng cho thấy
analytics `PENDING` khoảng 28.447, trang `PERSISTING` khoảng 28.547. Đây là bằng
chứng backlog analytics làm Crawler mất readiness; không có bằng chứng CPU/RAM
hoặc Hikari cạn. Sau 10 phút chờ hủy và 90 giây recovery, 7 scan của lượt này
đã `CANCELLED`, 43 scan còn `CANCEL_REQUESTED`; Crawler readiness vẫn 503.
Recovery chưa hoàn tất tại 09:55 UTC. Việc theo dõi chỉ đọc sau đó cho thấy
analytics outbox giảm đều từ 24.147 bản ghi lúc 09:59 UTC về **0 lúc 11:25 UTC**.
Hai mẫu 11:25 và 11:26 UTC xác nhận không còn scan active, Control Plane/Crawler
live/Crawler ready/Capture đều HTTP 200. Truy vấn đúng nhóm tài khoản của lượt
chạy lại trong Control Plane cho thấy **50/50 scan cuối cùng `CANCELLED`**.
Production giữ nguyên release, giới hạn 1.000 trang/scan, fixture chính khỏe và
route 50 hostname synthetic đã tắt. Credential tạm của harness không được lưu.

Kết luận có thể dùng: **WebLens nhận được 50 yêu cầu scan đồng thời trên workload
1.000 trang/tài khoản, nhưng không duy trì được Crawler readiness đến khi chúng
hoàn tất**. Đây là mức đầu tiên đã đo cho workload 50 × 1.000 và bị stop guard;
không phải bằng chứng rằng hệ thống hỗ trợ 50 concurrent users crawl hoàn tất.
Điểm nghẽn đầu tiên có bằng chứng là đường delivery/ack analytics: backlog làm
readiness vượt ngưỡng 15 phút trong khi CPU, RAM và Hikari còn dư.

## Chẩn đoán analytics 2026-09-30 — trước tối ưu

Release chẩn đoán `5f7d6c3194209b221f618526d54f91ec9a98555c` chỉ thêm timing
theo stage, không thay đổi concurrency hoặc hành vi xử lý. Workload dùng 10 tài
khoản, 10 scan đồng thời và tối đa 1.000 trang/scan trên fixture synthetic. Sau
khi thu đủ 11 batch đầy đủ, toàn bộ scan được yêu cầu hủy để giới hạn ảnh hưởng
lên production.

Mỗi batch chứa 100 trang. Giá trị trung bình của 11 batch:

| Stage | Thời gian trung bình | Tỷ lệ trên tổng |
|---|---:|---:|
| Claim PostgreSQL | 46,45 ms | 0,21% |
| Tra receipt ClickHouse | 18.314,45 ms | 83,29% |
| Insert page metrics | 505,18 ms | 2,30% |
| Insert findings | 516,18 ms | 2,35% |
| Insert links | 469,36 ms | 2,13% |
| Insert receipts | 436,64 ms | 1,99% |
| Acknowledge PostgreSQL | 1.636,09 ms | 7,44% |
| Tổng | 21.988 ms | 100% |

`receiptExists` thực hiện tuần tự một truy vấn ClickHouse cho từng trang. Riêng
100 lần tra receipt mất trung bình 18,31 giây, trong khi bốn lượt insert cộng lại
chỉ khoảng 1,93 giây. Throughput suy ra từ timing là khoảng 4,55 trang/giây,
khớp với plateau 4,4–4,74 trang/giây ở các bài đo crawler trước đó. Đây là bằng
chứng trực tiếp xác định truy vấn receipt tuần tự là bottleneck đầu tiên; bước
acknowledge từng trang trong PostgreSQL là ứng viên thứ hai.

Tại snapshot giữa lượt chạy, 10 scan đang RUNNING, CPU 40,1%, RAM dùng khoảng
49%, Hikari pending 0, analytics retry không tăng; queue có 6.786 trang và
2.269 trang ở `PERSISTING`. Điều này tiếp tục loại trừ CPU, RAM và connection
pool Control Plane là nguyên nhân đầu tiên của plateau trong workload này.

### Tối ưu có chủ đích và benchmark lại

Commit `9e87e8b0c95ea1791dcc4814793e45b1e391ca36` thay 100 truy vấn receipt
tuần tự bằng một truy vấn ClickHouse cho cả batch, dùng đủ bộ khóa
`owner_id`, `aggregate_id`, `batch_id`. Không đổi schema, batch size, concurrency
hay giới hạn scan. `go test ./...`, `go vet ./...`, `git diff --check` và toàn bộ
CI/deploy run `36613927956` đều đạt. Production xác nhận chạy đúng commit này.

Lượt sau tối ưu dùng lại 10 tài khoản riêng, 10 hostname synthetic, 10 scan đồng
thời và 1.000 trang/scan. Hai lượt đầu sau deploy không hợp lệ vì route wildcard
synthetic chưa bật: HTTP bị từ chối ở cổng 80; HTTPS gặp lỗi TLS của hostname
wildcard. Sau khi bật đúng route HTTP và preflight trang fixture trả 200, lượt
`20260929T185759Z` hoàn tất **10/10 scan, 10.000/10.000 trang thành công** trên
cả Crawler và Control Plane, không có trang lỗi. Thời gian từ scan đầu được nhận
đến scan cuối hoàn tất là 1.050,53 giây, tương ứng **9,52 trang/giây** cho toàn
bộ workload. Harness đọc API bị HTTP 401 do access token hết hạn ở cuối lượt;
trạng thái terminal và thời gian được xác nhận trực tiếp từ hai PostgreSQL.

Log analytics của đúng cửa sổ đo có 587 batch, tổng 10.000 receipt được kiểm tra
và acknowledge, 0 batch failed, 0 retry. Batch sau tối ưu chứa trung bình 17,04
trang do tốc độ fetch và poll hiện tại; thời gian tra receipt trung bình là
183,75 ms/batch. Để tránh so sánh hai batch khác kích thước như nhau, chuẩn hóa
theo mỗi trang:

| Chỉ số | Trước | Sau | Thay đổi |
|---|---:|---:|---:|
| Tra receipt/trang | 183,14 ms | 10,79 ms | giảm **94,11%** |
| Lượt tra ClickHouse cho 100 trang | 100 | 1 theo batch 100 trang; 587 lượt cho 10.000 trang thực đo | giảm số lượt theo cơ chế batch |
| Workload 10 × 1.000 hoàn tất | Bị guard hủy sau khi đủ mẫu timing | 10/10 scan, 10.000 trang | Chỉ lượt sau có throughput hoàn chỉnh |

Telemetry sau tối ưu có 49 mẫu từ 18:57:47 đến 19:15:53 UTC: CPU trung bình
27,26%, max 51,6%; RAM dùng max 50,97%; Hikari active max 1, pending max 0,
timeout delta 0; queued page max 7.052, `PERSISTING` max 85; analytics pending
max 28, claimed max 57. Page/analytics/event retry delta đều 0; browser process
max 0. Sau lượt đo, backlog analytics và scan active đều về 0, Control Plane,
Crawler live/ready và Capture đều HTTP 200; cả hai route fixture đã tắt.

**Giới hạn so sánh:** Lượt trước dùng đúng workload 10 × 1.000 nhưng bị hủy có
chủ đích sau khi thu timing, nên không có throughput hoàn chỉnh trước tối ưu để
tính phần trăm cải thiện throughput end-to-end. Con số 94,11% là cải thiện được
đo cho bước tra receipt trên mỗi trang; 9,52 trang/giây là throughput hoàn chỉnh
của lượt sau. Đây chưa phải bằng chứng cho capacity 50 scan × 1.000 trang hoặc
breaking point mới.

### Lượt 50 scan đầu sau tối ưu bị guard dừng

Run `20260929T193147Z`, commit production
`9e87e8b0c95ea1791dcc4814793e45b1e391ca36`. Raw artifact:
`tmp/load/phase7-50x1000-20260929T193147Z`. Trước tải, đã backup mới cả ba
PostgreSQL và đối chiếu SHA-256, dung lượng, TOC ở
`tmp/load/offhost-backups/performance-preflight-20260929T192922Z`. Fixture
synthetic 1.000 trang/hostname được kiểm tra trên ba hostname; 50 tài khoản
riêng gửi 50 scan đồng thời. Sau tải, route wildcard đã tắt.

k6 gửi thành công **50/50 yêu cầu tạo scan**, admission p50 **174,28 ms**, p95
**275,88 ms**, exit code 0. Trong lượt đo, tổng active/queued scan đạt 50,
queued page tối đa 8.207; CPU VPS tối đa 52,8%, RAM tối đa 61,24%, Hikari
pending tối đa 0. Page, analytics và event retry không tăng. PostgreSQL
Control/Crawler vẫn có kết nối hoạt động, không thấy lock wait tại các mẫu quanh
lỗi; collector ClickHouse crawl/capture chuyển sang `unavailable` từ khoảng
19:34:37 UTC (probe count timeout 4 giây), trong khi PostgreSQL vẫn thu được.
Crawler readiness dùng timeout 2 giây và phụ thuộc lần lượt PostgreSQL,
ClickHouse, tuổi backlog analytics. Probe readiness thất bại trong cửa sổ này;
guard `service_health_failed` dừng tải và gửi hủy. Log analytics vẫn ghi các
batch được acknowledge, không retry; backlog pending/claimed ở mẫu cuối trước
hủy là 43/64. Vì harness chưa ghi từng mã HTTP và thời gian của ba health probe
tại thời điểm guard, **chưa xác định được dependency cụ thể gây readiness lỗi**.
ClickHouse chậm cùng thời điểm là giả thuyết cần xác minh, không phải kết luận.

Kết quả cuối: **50/50 `CANCELLED`, 0 scan hoàn tất**. `processedPages=9.919` và
giá trị 114,66 trang/giây trong manifest là tiến độ của workload đã hủy, **không
phải throughput hay capacity hoàn chỉnh**. Sau khi hủy, backlog analytics và
active scan về 0; Control Plane, Crawler live/ready, Capture đều HTTP 200. Bài
test này chứng minh admission 50 yêu cầu trong điều kiện đã đo, chưa chứng minh
khả năng hoàn tất 50 × 1.000 trang. Chi tiết health probe và lỗi ClickHouse được
ghi nhận thêm ở lượt retest bên dưới.

### Lượt xác nhận 50 scan × 1.000 trang

Run `20260929T194638Z`, cùng commit production
`9e87e8b0c95ea1791dcc4814793e45b1e391ca36`. Raw artifact:
`tmp/load/phase7-50x1000-20260929T194638Z`. Trước tải, đã tạo backup mới cho ba
PostgreSQL, tải bản sao về máy và đối chiếu SHA-256, dung lượng cùng TOC tại
`tmp/load/offhost-backups/performance-preflight-20260929T194453Z`. Fixture được
kiểm tra trên ba hostname synthetic do mình kiểm soát.

**50/50 scan được gửi đồng thời và hoàn tất; 50.000/50.000 trang thành công,
không trang lỗi.** Đây là 50 scan jobs cạnh tranh qua scheduler giới hạn 20 slot,
không phải 50 crawler worker xử lý trang cùng lúc. Thời gian từ lúc gửi tải đến
scan cuối hoàn tất là 4.083 giây, throughput tổng thể
**12,25 trang/giây**. k6 nhận 50/50 yêu cầu, p50 admission **140,74 ms**, p95
**216,26 ms**; p99 không có giá trị trong summary và không được suy diễn.
Duration scan có median **746,93 giây**, p95 **1.881,64 giây**, max **2.063,58
giây**.

Telemetry 236 mẫu VPS và 596 mẫu máy phát tải: CPU VPS max **51,4%**, RAM max
**62,07%**; Hikari pending/timeout delta bằng 0; active scans/executions max 50,
cuối lượt 0; queued page max **7.186**, cuối lượt 0. Đủ **50.000 page thành
công/50.000 lần thử**, không page retry; analytics/event retry, telemetry-source
failure và service failure đều không tăng. Control Plane, Crawler live/ready và
Capture trả HTTP 200 sau phục hồi. Analytics backlog và active scan đều bằng 0.
Route wildcard fixture đã tắt, public fixture không truy cập được, fixture
service vẫn chạy.

Lượt đầu 50 scan thất bại khi Crawler readiness tạm thời lỗi đồng thời ClickHouse
count probe timeout; lượt xác nhận này không lặp lỗi readiness. Không thể khẳng
định nguyên nhân cụ thể của lần đầu chỉ dựa trên dữ liệu đó.

### Lượt 75 scan × 1.000 trang

Run `20260930T014412Z`, cùng commit production
`9e87e8b0c95ea1791dcc4814793e45b1e391ca36`, trên Windows VPS 8 logical
CPU, khoảng 7 GiB RAM. Cấu hình vẫn giới hạn tối đa 20 scan slot, hai slot mỗi
host và 1.000 trang/scan. 75 tài khoản riêng gửi 75 scan gần đồng thời đến 75
hostname fixture synthetic. Backup mới ba PostgreSQL được tải ra ngoài VPS và
kiểm SHA-256, dung lượng, TOC tại
`tmp/load/offhost-backups/performance-preflight-20260930T014216Z`. Raw artifact:
`tmp/load/phase7-75x1000-20260930T014412Z`.

Đối chiếu trực tiếp Control Plane và Crawler PostgreSQL theo thời gian tạo scan
và hostname fixture: **75/75 scan `COMPLETED`, 75.000/75.000 trang thành công,
0 trang lỗi, 75.000/75.000 analytics đã publish; 75.000 page attempts, 0 retry**.
Từ scan đầu bắt đầu đến scan cuối kết thúc là **9.492,62 giây**, thông lượng
end-to-end **7,90 trang/giây**. Thời lượng mỗi scan median **1.023,90 giây**,
p95 **2.442,81 giây**, max **2.998,94 giây**. k6 gửi đủ 75/75 scan, lỗi HTTP
0/150 request; admission p50 **210,89 ms**, p95 **363,63 ms**. Summary k6 không
có p99, nên không ước lượng p99. Nếu áp SLO API ban đầu p95 dưới 300 ms cho
endpoint tạo scan thì lượt này không đạt; ngưỡng riêng k6 cho admission p95 dưới
1 giây vẫn đạt.

Trong 372 mẫu progress, không mẫu nào báo health fail; CPU VPS quan sát tối đa
**83,5%**, RAM tối đa **77,86%**. Collector có 504 mẫu VPS và 1.302 mẫu máy phát
tải; Hikari pending và timeout delta quan sát bằng 0, browser process cuối lượt
bằng 0. CPU máy phát tải có mẫu đạt 100%, cũng cần tính đến khi diễn giải thời
gian admission. Active scan/execution quan sát tối đa 75 và về 0; queued page quan sát
tối đa 5.711 và về 0. Tuy nhiên truy vấn `crawler.workload` của collector thất bại
**427/504 mẫu**, và một mẫu Actuator không khả dụng. Vì vậy cực đại hàng đợi,
retry delta và các chỉ số crawler lấy bằng hiệu hai mẫu collector **không đủ tin
cậy** cho lượt này; retry 0 ở trên được xác minh riêng bằng bảng `scan_pages`.
Collector đặt timeout truy vấn PostgreSQL 2 giây và tổng hợp toàn bảng
`scan_pages`; đây là ứng viên gây mất mẫu, chưa phải nguyên nhân đã chứng minh.
Collector không ghi được level manifest sau bước chờ hậu tải; wrapper báo
`FAILED_RESTORED`. Đây là lỗi hoàn tất báo cáo đo, không phải scan thất bại;
nguyên nhân cụ thể của lỗi collector chưa được xác định. Trạng thái sau tải đã
kiểm riêng: analytics backlog 0, không còn active scan; Control, Crawler live,
Crawler ready và Capture đều HTTP 200. Route synthetic đã tắt, fixture service
vẫn chạy.

Khoảng 02:37 UTC có nhiều tiến trình `morelogin.exe` ngoài WebLens chạy trên VPS;
mẫu CPU/RAM tăng trong khoảng này. Lượt 75 scan có tổng số trang và thời gian
chờ khác lượt 50, đồng thời bị nhiễu bởi tải ngoài. Mức 7,90 so với 12,25
trang/giây **không chứng minh hiệu năng WebLens suy giảm 35,5%** và không dùng
để suy ra saturation point. Kết luận an toàn: production đã hoàn tất workload
75 scan jobs, mỗi scan 1.000 trang, trong điều kiện đã đo; chưa chứng minh 75
crawler worker chạy song song hay mức tải cao hơn.

### Baseline 150 scan × 1.000 trang cùng 150 người thao tác API

Run `20260930T083903Z`, commit production
`9e87e8b0c95ea1791dcc4814793e45b1e391ca36`. Raw artifact:
`tmp/load/phase8-150x1000-20260930T083903Z`. VPS Windows có 8 logical CPU,
khoảng 7 GiB RAM; crawler giữ 20 worker, hai slot/host, giới hạn 1.000
trang/scan. 150 tài khoản và 150 website synthetic riêng biệt dùng 150 hostname
`phase5-NNN.jobnext.top` do mình kiểm soát. Ba PostgreSQL đã được backup ra máy
phát tải trước lượt chạy, đối chiếu kích thước và SHA-256 tại
`tmp/load/offhost-backups/performance-preflight-20260930T083411Z`.

**150/150 scan `COMPLETED`; 150.000/150.000 trang thành công, 0 trang lỗi.**
Đối chiếu `scans.json` có 150 scan ID và 150 tài khoản khác nhau. Truy vấn trực
tiếp Crawler PostgreSQL theo cửa sổ admission và hostname fixture trả về 150
execution, 150.000 page `SUCCEEDED`, 150.000 page attempts và **0 retry**. Từ
scan đầu bắt đầu đến scan cuối kết thúc là **9.437,89 giây** (khoảng 2 giờ 37
phút), thông lượng end-to-end **15,89 trang/giây**. Thời lượng từng scan median
690,99 giây, p95 887,50 giây, tối đa 1.288,80 giây. Có thời gian xếp hàng:
150 scan được nhận, nhưng chỉ một phần chạy cùng lúc; đây không phải 150
crawler worker xử lý trang đồng thời.

Admission k6 nhận đủ 150/150 scan, p50 **294,38 ms**, p95 **600,51 ms**;
summary không có p99. Trong **10 phút đầu của quá trình crawl**, 150 VU, mỗi VU
dùng một tài khoản riêng và giãn khoảng 3 giây giữa các thao tác, đã gửi
**28.157 request**, trung bình **46,69 request/giây**. Có một HTTP 502 ở
`auth_login` (error rate **0,00355%**). Toàn bộ request có p50 **44,91 ms**,
p95 **674,83 ms**; `scan_pages` có p95 **936,02 ms**, p99 **1.890,93 ms**.
Dashboard có p95 **228,88 ms**. Phần API chỉ kéo dài 10 phút, không đại diện
cho 150 người thao tác liên tục suốt 2 giờ 37 phút. Theo SLO ban đầu API p95
dưới 300 ms, workload hỗn hợp này **không đạt về độ trễ**, dù error rate dưới 1%.

583 mẫu VPS: CPU tối đa **82,4%**, RAM tối đa **82,52%**; Hikari pool tối đa 10
kết nối active, một mẫu lúc `08:48:17 UTC` có **5 request pending** và 10 kết
nối PostgreSQL ở trạng thái `idle in transaction`. Hikari timeout không tăng.
Mẫu này là bằng chứng áp lực kết nối tạm thời, chưa đủ xác định nguyên nhân
gốc hoặc kết luận đây là saturation point. Không có service failure hoặc
telemetry-source failure trong các mẫu. Crawler active execution và queued
page đều về 0. Sau tải, analytics backlog 0; Control, Crawler live/ready và
Capture đều HTTP 200. Route synthetic đã tắt; fixture service vẫn chạy.

Harness ghi `STOPPED_BY_GUARD` với lý do `hikari_pending_gt_zero` ở **bước
đánh giá sau khi cả 150 scan đã hoàn tất**, vì ngưỡng guard yêu cầu pending
bằng 0 trong mọi mẫu. Đây không phải hủy scan giữa chừng. Kết quả hoàn tất
crawl là hợp lệ, nhưng chưa thể gọi đây là mức tải đạt toàn bộ tiêu chí API.

### Thử tối ưu transaction API — workload 150 scan bị dừng theo RAM guard

Run `20260930T122538Z`, artifact
`tmp/load/phase8-api-after-20-150x1000-20260930T122538Z`, backend patch SHA-256
`116e6da21037c8a9e898dba9b81171406842ff5887990475d14db955e965532b`.
Crawler vẫn giữ 20 worker, hai slot mỗi host. 150/150 scan được nhận; sau hai
mẫu RAM liên tiếp 90,18% và 90,19%, guard dừng workload. Kết quả: **127 scan
hoàn tất, 23 bị hủy**; tổng page counter gồm tiến độ một phần của scan bị hủy
là 130.475 thành công và 3.697 lỗi. Không được tính lượt này là 150.000 trang
hoàn tất hoặc dùng làm capacity hoàn thành.

Trong 10 phút API: 28.591 request, 47,36 request/giây, p95 588,73 ms, p99
785,49 ms; 15 request lỗi HTTP 404 đều ở `scan_pages`. So với baseline 150-VU,
p95 tổng giảm 12,76%, nhưng vẫn vượt SLO 300 ms. p95 `scan_pages` giảm từ
936,04 ms còn 769,59 ms; các endpoint đọc danh sách khác cũng giảm p95 trong
cửa sổ này. Đây là tín hiệu trong cửa sổ 10 phút, chưa phải before/after
end-to-end vì workload crawl bị hủy. 15 lỗi 404 tập trung trong khoảng hai
giây, khoảng 15 giây sau admission. Crawler trả 404 khi chưa có execution row
cho report, nên khả năng request đến trước khi Crawler nhận scan là hợp lý;
chưa xác minh được từng request.

Rà soát source sau đó xác nhận một đường đi cụ thể: endpoint trang kiểm tra
scan/owner trong Control Plane, sau đó Crawler đọc `crawl_executions`; nếu chưa
có execution row thì `GetReportState` trả `ErrReportNotFound` và handler trả
HTTP 404 trước các truy vấn ClickHouse. K6 của lượt này chỉ lưu status, không
lưu error code/body hoặc scan ID, nên chưa kết luận 15 lỗi thuộc nhánh đó; scan
không tồn tại/không thuộc owner cũng có thể tạo 404 ở bước Control Plane.
Harness local đã được cập nhật để ghi metric `weblens_api_errors` theo endpoint
và error code đã lọc trong lượt sau. Mốc 15 lỗi trong artifact là
12:30:42.261–12:30:44.585 UTC. Đây là kết quả phân tích mã nguồn và artifact,
không phải xác minh runtime; bản sửa harness chưa phát request mới.

Lưu ý bổ sung: Control Plane đổi cả 404 từ Crawler và lỗi scan/owner không tồn
tại thành `SCAN_PAGE_NOT_FOUND`; error code K6 chưa đủ xác định nguồn. Cần đối
chiếu log Crawler theo scan ID. Probe chỉ đọc lúc 16:34 UTC trên một scan
synthetic hoàn tất, `limit=20`, trả 200 trong 1.298/915/624 ms cho ba mẫu. Đây
là latency từ PowerShell client gọi trực tiếp Crawler, gồm đọc/parse kết quả;
không phải p95, không có tải crawl và không dùng để tính cải thiện baseline.
Đối chiếu collector phát hiện bản VPS vẫn quét dữ liệu lịch sử; truy vấn nhẹ
chỉ lọc trạng thái hoạt động sau đó xác nhận active execution/page/host lease
và analytics backlog đều 0. Chi tiết và artifact ở nhật ký tối ưu Phase 3.

Sau tải, telemetry ghi active page/host lease/analytics backlog bằng 0 và
Hikari pending bằng 0; cả ba service health trả 200. Route synthetic đã tắt,
fixture service vẫn chạy nội bộ. Wrapper báo `FAILED_RESTORED` do lỗi tổng hợp
queue wait khi scan bị hủy trước lúc có `startedAt`; harness và analyzer đã
được sửa để bỏ những scan đó khỏi percentile thời gian chờ. Backend patch được
rollback, SHA-256 production trở về bản gốc
`5bff335f8975fc8830a3328895fb4ebe79eb92b53473b85d9304c06fd3e3035f`.
Kiểm tra sau rollback xác nhận ba service khỏe và route vẫn tắt.

RAM không ổn định để tăng worker: sau rollback còn khoảng 0,61 GiB trống, rồi
tăng lên 1,16 GiB ở lần kiểm tra tiếp theo. Danh sách process có MoreLogin,
Chrome và Windows Defender; lượng RAM của chúng đúng thời điểm chạm guard
không được đo riêng, do đó không quy nguyên nhân cho backend patch. Cần đo lại
chỉ khi có headroom production ổn định; chưa chuyển worker lên 40/64.

## Capacity, saturation, bottleneck và before/after

Trong workload API shared-account đã đo, 10 VU đạt SLO và 50 VU là mức đầu tiên
không đạt; điểm chính xác nằm trong khoảng chưa đo 11–49 VU. Baseline có mẫu
Hikari pending và transaction `idle in transaction`; transaction bao trùm
outbound report call là nguyên nhân ứng viên. Bản sửa `NOT_SUPPORTED` làm p95
API giảm trong cửa sổ 10 phút, nhưng lượt 150 scan bị dừng vì RAM và patch đã
được rollback; do đó chưa có benchmark end-to-end đủ để chấp nhận thay đổi.

Trong workload crawler 100 trang/scan, 25 concurrent scans là mức cao nhất đã đo
bền vững và throughput bắt đầu plateau ở 10 scan. Breaking point chưa đo vì bậc
50 dừng trước khi gửi tải theo rào chắn RAM. Bottleneck crawler đầu tiên là backlog
analytics persistence/delivery sau khi fetch queue đã rỗng.

Large scan 1.000 và 10.000 trang đã hoàn tất ở lần lượt 1,8233 và 1,7487
trang/giây trên fixture synthetic trước tối ưu. Hai workload khác độ sâu và thời
lượng, nên không diễn giải chênh lệch này là cải thiện hay suy giảm do tối ưu.
Tối ưu tra receipt giảm 94,11% thời gian stage trên mỗi trang; lượt 10 scan ×
1.000 trang sau tối ưu hoàn tất 10/10 ở 9,52 trang/giây. Chưa có phần trăm cải
thiện throughput end-to-end cùng workload trước/sau tối ưu vì lượt 50 scan trước
tối ưu bị hủy. Lượt 50 × 1.000 sau tối ưu đạt 12,25 trang/giây; lượt 75 × 1.000
hoàn tất ở 7,90 trang/giây nhưng có tải ngoài và lỗ hổng telemetry crawler.
Lượt 150 × 1.000 cùng 150 VU API trong 10 phút đầu hoàn tất 150/150 scan ở
15,89 trang/giây, nhưng API p95 674,83 ms vượt SLO 300 ms và một mẫu Hikari
pending = 5 kích hoạt guard sau tải. Đây là bậc scan lớn nhất đã hoàn tất,
không phải breaking point hay mức tải đạt toàn bộ SLO. Các lượt 50, 75 và 150
có điều kiện và tải API khác nhau, nên không lấy chênh lệch throughput làm tỷ
lệ cải thiện do thay đổi worker. Spike, stress, browser capacity và soak còn
chưa đo.

## Chẩn đoán report bổ sung — 2026-09-30 16:49–17:03 UTC

Hai lượt SQL chỉ đọc trên một scan synthetic đã hoàn tất cho thấy tổng ba
query report mất 99,54 và 74,12 ms tại ClickHouse, trong khi tổng roundtrip
HTTPS là 1.405 và 1.142 ms. Mỗi lượt đọc tổng 115.124 dòng/19.088.717 byte
qua page list, findings và summary. Đây không phải p95 dưới tải; production
dùng native transport và pool tái sử dụng, nên chưa kết luận roundtrip HTTPS
chính là bottleneck production hoặc tính phần trăm cải thiện baseline.

Truy vấn lấy 21 trang bị chặn bởi trần bộ nhớ probe 128 MiB: ClickHouse báo
cần 129,24 MiB khi đọc `page_metrics`; cùng SQL thành công với trần probe
256 MiB. Không thay giới hạn production, không đo peak memory thành công và
không suy ra mức RAM cần cho nhiều người dùng từ mẫu này. Query log code 497
do thiếu quyền; cần đo stage qua native transport/instrumentation trước tối ưu.

Hai mẫu readiness đúng endpoint đều HTTP 200, RAM 72,25%/71,84%; mẫu Hikari
active/pending/idle 0/0/2. Probe PostgreSQL có timeout 2 giây/lock 500 ms và
read-only xác nhận active execution, page backlog, host lease và analytics
backlog đều rỗng. Route synthetic tắt; backend vẫn bản rollback gốc. Chưa
deploy tối ưu mới, tăng worker hoặc chạy benchmark tiếp. Chi tiết và artifact
được ghi trong `PERFORMANCE_OPTIMIZATION_EXECUTION.md`.

### Xác minh native và chuẩn bị tối ưu report

Diagnostic dùng cùng thư viện/kết nối native của Crawler, đọc ba report tuần tự
trên fixture đã hoàn tất: `ListPages` + `ScanSummary` tổng 906,206 / 650,115 /
635,648 ms, kết quả 20 trang và tổng 1.000 URL đúng ở cả ba lượt. Ping trên kết
nối native tái sử dụng mất 238,259 / 237,975 / 236,525 ms. Chi phí trao đổi với
ClickHouse là hướng tối ưu đã có bằng chứng; chưa xác định tuyến mạng/địa lý
hoặc suy ra p95/capacity từ mẫu nhỏ này. Phép đo không gồm Control Plane,
PostgreSQL report-state hay crawl đồng thời.

Đã chuẩn bị commit Crawler `c27edfb` trong checkout riêng: chạy page list và
summary song song, giữ query/summary scan-wide, authorization và pagination;
hủy nhánh còn lại khi một nhánh lỗi. Go tests/build đạt, race detector chưa
chạy được do thiếu CGO/compiler local. Bản sửa chưa deploy hoặc benchmark;
chưa có % cải thiện được xác nhận. Cần đo nguy cơ chờ pool/tăng tải analytics
trước khi triển khai. Production sau diagnostic vẫn ba health HTTP 200, RAM
71,48%, route synthetic tắt; backend và Crawler hashes không đổi.

### Microbenchmark ứng viên song song report

So sánh ABBA bằng handler thực và native analytics: 28/28 response đúng,
body SHA giống nhau. Warm median (n=4 mỗi nhóm) giảm từ 604,693 xuống
453,8415 ms cho request đơn (24,95%) và từ 655,601 xuống 460,1105 ms cho
hai request đồng thời (29,82%). Fixture report-state cố định thay PostgreSQL;
phép đo không gồm Control Plane/HTTP network/crawl đồng thời, không phải p95
hoặc capacity và không chứng minh 150/500 người đạt SLO.

Đã chuẩn bị backup Crawler ngoài VPS và patch manager có smoke test rollback.
Deploy chưa diễn ra vì preflight health timeout; kiểm tra lại 18:26 UTC cả ba
endpoint đều 200 với curl và Invoke-WebRequest, RAM 73,78%, route synthetic tắt,
backend/Crawler hash gốc. Chưa xác định nguyên nhân timeout. Chờ validation
production và benchmark cùng workload trước khi chấp nhận tối ưu.

18:30 UTC đã triển khai riêng Crawler `c27edfb`; giữ backend gốc, 20 worker,
host 2. Ba report HTTP trước/sau đều đúng và cùng body SHA; snapshot 18:32 đọc
được mọi nguồn telemetry, không active scan/backlog, RAM 72,46%. Chưa có kết quả
tải lớn sau sửa; các mức giảm microbenchmark chưa được dùng làm capacity.

Lượt `20260930T184745Z` dừng trong setup k6: 79 request login, một timeout 5
giây, chưa gửi scan hoặc chạy mixed API. Wrapper `FAILED_RESTORED`, route tắt,
ba health 200 sau cleanup. Telemetry có RAM tối đa 69,39%, CPU 23,2%, Hikari
pending 0 và backlog 0; chưa xác định nguyên nhân timeout. Không có số liệu
crawl/capacity hoặc before/after tải lớn từ lượt này.

Retry `20260930T185748Z`: setup login đủ 150, admission 121 response 202 và
29 HTTP 0; admission p95 4.796,85 ms, lỗi 19,33%. DB xác nhận cả 150 scan đã
commit, nhưng client không biết ID của 29 scan timeout. Harness hủy 121 scan
đã biết, không chạy mixed API; đây không phải benchmark đủ workload.
51 mẫu VPS có CPU max 19,8%, RAM max 72,08%, Hikari active 10/pending max 29,
lock chờ max 3, không có Hikari timeout. Cần chẩn đoán transaction/pool/lock
tại admission; chưa gán regression cho report chưa được gọi. Đã gửi cleanup
command cho 29 scan bị bỏ sót; chờ xác minh terminal/backlog, không công bố
capacity hoặc % cải thiện từ lượt bị hủy.

19:21 đã xác minh 150/150 CANCELLED và backlog sạch, sau đó rollback Crawler.
19:25:33 cả Control Plane/Crawler active scan, queue/lease và outbox/analytics
backlog bằng 0; ba health HTTP 200, hai route tắt, RAM 67,54%, backend và
Crawler đúng hash gốc. Production đã phục hồi; ứng viên report chưa được chấp
nhận dưới tải. Cần sửa harness nhận diện scan đã commit khi client timeout và
đo transaction/SQL/lock ở admission trước test tiếp. Phase 4–6 chưa hoàn tất.
# Cập nhật chẩn đoán 2026-09-30 20:10 UTC

Không có lượt load test mới. Baseline 150×1.000 và các lỗi admission trước đó
giữ nguyên; chưa có before/after workload hoàn chỉnh hoặc capacity mới.

Raw admission của run `20260930T185748Z`: waiting median 3.472,50 ms,
p95 4.796,85 ms; blocked median 229,28 ms, p95 309,63 ms. 150 quan sát gồm
29 timeout; không phải timing SQL/transaction. Mixed API/report chưa chạy.
Artifact: `tmp/load/phase3-admission-client-timings.json`.

Harness local đã sửa phục hồi ID sau timeout và lưu identifiers công khai
trước admission, giữ lỗi client khi đối chiếu server; kiểm thử không dùng
mạng đạt với 121 ACK + 29 committed timeout, cleanup đủ 150 scan mô phỏng.
Thêm gate hai mẫu telemetry thật và trạng thái mixed `NOT_STARTED`; chưa
chạy tải production để xác nhận harness mới.

Probe 20:10:57: ba health UP, RAM 66,77%, hai route off, hai binary gốc,
mọi backlog đã đo bằng 0. Verifier còn thiếu đối chiếu orphan PERSISTING và
event DEAD của Crawler; `globalRecoveryVerified=false`, không đổi unknown
thành 0. Probe count toàn cục trước đó timeout 2 giây; EXPLAIN chỉ ra Seq
Scan lịch sử, đã dừng dùng những query đó. Chưa đổi schema/grants/runtime.
Chi tiết và việc tiếp theo nằm trong `PERFORMANCE_OPTIMIZATION_EXECUTION.md`.

## Cập nhật diagnostic 2026-09-30 21:04 UTC

Chưa có load test hoặc before/after mới. Phase 3–6 còn mở; chưa công bố capacity
500 người hoặc chấp nhận ứng viên tối ưu production.

Audit PERSISTING qua execution/status index vẫn timeout 2 giây; lượt chia batch
ghi SQLSTATE 57014, chưa có kết quả xác nhận toàn cục. Đã sửa gate EXPLAIN bị bỏ
qua bởi wrapper PowerShell `value/Count` và thêm kiểm thử offline trên PowerShell
5/7; chưa thực thi lại audit. Catalog outbox có estimate 1.437.930 live tuples;
estimate 161.222 MVCC dead tuples không phải số event DEAD. Plan DEAD chọn Seq
Scan, chưa thực thi hoặc đổi schema. Recovery global vẫn chưa được xác nhận.

Đã lưu bản đo admission mặc định tắt ở commit `044fa4f` trên base production
`9e87e8b`, nhánh riêng không chứa NOT_SUPPORTED. 9/9 unit tests và package đạt;
chưa deploy, chưa đo proxy/DB thật, chưa chứng minh tăng throughput/giảm latency.
Actuator hiện đã có Hikari acquire/usage, nhưng snapshot là thống kê toàn pool;
không dùng làm p95 admission hoặc so phần trăm với baseline.

21:00:11 Crawler/Capture có curl timeout; recheck 21:01:43 cả ba endpoint trả
HTTP 200, RAM 66,70%, sáu service Running, routes off, backend/Crawler bản gốc.
Backlog trong scope đã đo vẫn 0; hai scope PERSISTING ngoài active execution và
Crawler event DEAD chưa xác minh. Không chạy tải mới hoặc tắt máy. Artifact,
hash, giới hạn số liệu và bước tiếp theo đã ghi vào báo cáo thực thi.

21:15:27: thêm probe catalog/statistics read-only, không quét count lịch sử.
Event outbox heap 1.421.230.080 byte; page tháng 9 heap 194.101.248 byte.
Page execution/status indexes valid/ready, mẫu activity không có transaction
đang mở được quan sát hoặc lock wait. Không dùng mẫu này để giải thích timeout
admission hoặc tuyên bố global backlog rỗng. Đã chuẩn bị phạm vi review hai index
giám sát trong `docs/database/PERFORMANCE_RECOVERY_MONITORING_REVIEW.md`;
chưa có migration, deployment hoặc bài test mới. Global recovery còn UNVERIFIED.

21:25: bản đo admission có thêm kiểm thử Spring transaction proxy local, commit
`15455ab` chỉ đổi test; tổng 10/10 tests đạt. Transaction manager không có DB nên
chưa xác minh SQL, acquisition thực hoặc performance. JAR candidate `044fa4f`
không đổi và chưa deploy. Đang chờ review phạm vi index giám sát theo DESIGN_GATES;
không có workload hoặc capacity mới, không tắt máy.

21:37–21:42: 12 GET health nhỏ đều HTTP 200; không tái hiện timeout từ riêng loop
hoặc cách truyền URL. Verifier bổ sung URL/HTTP code/elapsed mà giữ nguyên guard;
proof 21:41:46 có cả ba health UP, RAM 66,85%, routes off, hashes gốc và backlog
đã đo 0. Scope recovery đã đo đạt, global proof vẫn false vì chưa đo DEAD và
PERSISTING ngoài active executions. Chưa xác định nguyên nhân timeout cũ; không
có load test, p95/capacity mới hoặc deployment. Review DB vẫn đang chờ.


## Kết quả cuối — 2026-10-03 01:55 giờ local (2026-10-02 18:55 UTC)

`worker64-500-after-claimfix`: 500 admission HTTP202, đủ 500 scan ID riêng biệt
đã đối chiếu với request/admission identities và bằng chứng cleanup cuối.
**464 COMPLETED, 36 CANCELLED; 464.000/500.000 trang succeeded, 0 failed**.
36 projection bị hủy có startedAt=null/processed0; audit ở đầu báo cáo xác nhận
cả36 execution Crawler đã hoàn tất. File `scans.json` trước
cleanup chỉ ghi 498 terminal; `cleanup-scans.json` bổ sung hai scan COMPLETED.
Projection chỉ phản ánh92,8% khối lượng; Crawler hoàn tất100%, nhưng trạng thái
người dùng thấy vẫn sai và bài500chưa đạt API/consistency.

Observed wall từ first start 10:10:06 UTC đến last finish 18:22:10 UTC:
29.523,985 giây, **15,7160 projected succeeded pages/s**, bao gồm event lag/chờ terminal sau hạn
8 giờ. Queue wait trong 464 scan đã bắt đầu: median 14.352,39 giây,
p95 27.385,65 giây, max 28.817,91 giây; không gồm 36 scan chưa bắt đầu.
Không dùng throughput này để công bố capacity 500/1.000 người hoặc coi fairness
đã được sửa. Lượt cũ hoàn thành 81 scan; lần này crawl cải thiện nhưng vẫn thiếu.

API500 chỉ chạy 10 phút (17:10–17:20 ngày 02/10 giờ local): **64.850 request,
1.947 lỗi / 3,0023%, p95 5.703,58 ms, k6 exit99**. Admission HTTP p95 99,55 ms,
client elapsed p95 3.908,15 ms. Giữ toàn bộ startup/login errors, timeout
ClickHouse và hai polling failures; API/SLO không đạt, chưa chứng minh 500
người hoạt động liên tục trong 8 giờ.

Manifest gốc `FAILED` vì harness hết thời gian chờ 180 giây cho SSH collector
(dòng1013); không ghi level summary. Wrapper `RECOVERY_UNVERIFIED` vì verifier
không hoàn tất. Mục tự động thiếu số liệu, gồm API request0 và routes off False
do không có proof, đã được thay bằng kết quả đối chiếu này; outcome gốc giữ nguyên.

Run terminal verified, seed/DPAPI đã được harness xóa. Mẫu telemetry cuối
18:22:07 UTC: active Control Plane/Crawler và backlog trong active scope đã đo0.
Proof18:53–18:54 UTC xác minh remote collector và wrapper đã thoát, hai routes
test off. Đã dừng riêng local SSH collector PID35880 còn sót sau khi remote
collector thoát, sau khi xác minh parent30516/command đúng run; proof exit đã lưu.
Không thay service/runtime hoặc phát tải mới. Global DEAD/orphan PERSISTING
vẫn unknown; không diễn giải scope0 thành global recovery sạch.

Artifacts trong run directory
`tmp/load/phase8-worker64-500-after-claimfix-500x1000-20261002T095900Z/`:
`final-cleanup-analysis.json`, `500-scans/cleanup-scans.json`,
`500-scans/vps-recovered.jsonl`. Proof bổ sung trong
`tmp/load/diagnosis-500-20261002/claimfixed500-{exit-route,routes-off,local-exit}-proof.json`.
Automation PAUSED, review index revision1 pending, phạm vi1.000 còn chờ;
không shutdown. Phương án API đã được cho phép, chưa triển khai trong lần kiểm này.

## 2026-10-03 — Kiểm thử code tối ưu local, chưa có lượt tải mới

Đã triển khai tối ưu report API, crawl dispatcher và event publisher tại local;
chi tiết trong [PERFORMANCE_RUNTIME_FIX_2026-10-03.md](PERFORMANCE_RUNTIME_FIX_2026-10-03.md).
Go test/vet/build PASS; 14 integration Crawler trên PostgreSQL test 18.4 PASS;
16 test Java liên quan PASS, gồm 5 integration cancellation. Kiểm thử xác minh
fencing, giới hạn xử lý đồng thời, lấy mẫu progress giữ terminal, validation,
timeout admission và đóng/trả tài nguyên. Chưa chạy race detector được vì thiếu
CGO/compiler; Docker không khả dụng nên ClickHouse thật và PostgreSQL 17 còn chờ.

Đây là kiểm thử tính đúng ở local. Chưa deploy, chưa đo lại API 500/crawl 500,
chưa kết luận API p95 < 1 giây, event p95 < 5 giây hoặc capacity 1.000 đã đạt.
Kết quả tải gần nhất vẫn giữ nguyên theo audit Crawler; không dùng timestamps
Control Plane trễ event để tính worker throughput. Automation PAUSED, index
revision 1 pending, global DEAD/orphan PERSISTING unknown, công việc 1.000 còn mở.

### Kiểm chứng candidate tiếp theo ngày 03/10/2026

Go race suite đạt trên PostgreSQL 17.6 và ClickHouse 26.3.39.7 local, gồm đọc
báo cáo đồng thời ingestion; 105 test/subtest action PASS, 0 skip. Backend 36 unit
và 14 integration PASS, 0 fail/error/skip. Build crawler Windows/backend JAR PASS.
Candidate commit `91f1d35e0944573af7904648908b58430dd56f4f`; manifest và
hashes tại `tmp/releases/runtime-verified-20261003/manifest.json`. Test DB/service
local đã dừng và xác minh port đóng. Chi tiết ở
[PERFORMANCE_RUNTIME_FIX_2026-10-03.md](PERFORMANCE_RUNTIME_FIX_2026-10-03.md).

Đây là kiểm chứng correctness local, chưa phải lượt tải production sau sửa.
Chưa deploy, chưa thay số API p95/errors, pages/s hoặc event lag của lượt 500.
Đo tiếp dự kiến 25 → 100 → 500; 1.000 vẫn chờ phạm vi đã hỏi. Không tuyên bố
global recovery sạch hoặc shutdown máy khi công việc còn mở.

### Triển khai production ngày 03/10/2026, chưa đo tải lại

Candidate `91f1d35e0944573af7904648908b58430dd56f4f` đã deploy backend/crawler,
hash đúng artifact kiểm chứng. Smoke một trang và hủy scan đạt; report fresh và
Control/Crawler terminal khớp. Đối chiếu ba scan gồm attempt harness đầu đã cleanup:
owner/version/status khớp, outbox DELIVERED, inbox APPLIED, scope backlog 0.
Final probe 06:09 UTC: health UP, active scans/executions 0, routes/hosts off,
không thấy process test/collector trong phép kiểm; website smoke đã archive.

Attempt đầu dừng do harness giả định maxPages<=25, trong khi cấu hình hiện vẫn
1.000; đã cancel/archive và lưu lỗi thật. Smoke sau dùng target một trang xác định,
không thay worker/config hoặc chạy tải hàng loạt. Các smoke không được dùng để
kết luận p95/errors/throughput ở 500 người đã cải thiện. Báo cáo tải 500 gần nhất
và trạng thái FAILED gốc giữ nguyên. Manifest deployment/evidence/rollback tại
`tmp/releases/runtime-verified-20261003/manifest.json`; chi tiết ở báo cáo runtime fix.
Global recovery chưa xác minh; mục tiêu 1.000 và công việc đo tải tiếp vẫn mở.

### Lượt 150 scan + 150 API sau sửa: đang chạy, 03/10/2026

Run `worker64-150-runtime-v1`, ID `20261003T062608Z`, wrapper PID 41140.
150 tài khoản × một scan 1.000 trang, đồng thời 150 VU API/10 phút dùng cùng tài
khoản; 150.000 trang yêu cầu, không phải 300 scan hoặc 300 tài khoản. Giữ worker64,
fixture cũ, timeout/SLO và errors thật. Chưa có kết quả cuối admission/API/crawl.

State/active proof ở `tmp/load/phase8-scheduled-state-worker64-150-runtime-v1.json`
và `tmp/load/runtime150-active-run.json`; evidence directory
`tmp/load/phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z/`.
150 identifiers seeding đã ghi, chưa coi là 150 admission thành công. Harness riêng
đã kiểm offline, runtime hashes khớp bản deploy. Seed giữ đến khi DB terminal đối
chiếu xong. Automation ACTIVE mỗi 15 phút; không kết luận PASS hoặc capacity trước
evidence. API chỉ 10 phút, khác chạy API liên tục trong toàn bộ crawl.

#### Admission đã đo, API còn chạy — 06:36 UTC

- 146/150 attempts HTTP 202; 4 timeout status 0/code 1050 sau khoảng 5 giây.
- Lỗi admission 2,6667%; tổng HTTP submission gồm login: 4/300 = 1,3333%.
- Response-only admission p95 698,63 ms; client elapsed mọi attempt p95
  3.192,55 ms/p99 5.046 ms. SLO elapsed và lỗi không đạt.
- Bốn attempt indices 103/104/134/145 chưa xác minh có tạo scan hay không;
  reconciliation UNRESOLVED. Không retry POST hoặc loại timeout khỏi kết quả.
- API 150 VU bắt đầu 06:29:58,475 UTC, chưa có summary cuối. 146 tài khoản có
  scan ID, bốn tài khoản còn lại đọc dashboard/websites/history.

Nguồn: `150-scans/submission-observations.json`, `submission-summary.json`,
`admission-reconciliation.json`, `mixed-state.json` trong evidence directory trên.
Chưa xác định nguyên nhân bốn timeout; timing transport zero không chứng minh
lỗi ở connection, backend, bcrypt hay ClickHouse. Crawl/terminal cleanup còn chạy;
không kết luận PASS, đủ 150 admissions hoặc global recovery sạch.

Read-only DB proof `150-scans/unresolved-db-live.json` lúc 06:37:38 UTC không có
record scan/execution cho bốn website timeout tại thời điểm đọc; vẫn giữ unresolved
đến đối chiếu cuối. Telemetry 06:37:13 UTC ghi 146 RUNNING ở hai phía, active-scope
pages 6.648 SUCCEEDED/4.806 PERSISTING. Không coi mẫu live là kết quả terminal hoặc
thông lượng của toàn bài; API summary còn chờ.

#### Kết quả API 150 VU/10 phút — 06:40 UTC, kiểm lúc 06:44 UTC

| Chỉ số | Kết quả |
| --- | --- |
| Tổng request, gồm login | 27.867 |
| Lỗi | 3 / 0,010765% |
| Request/s | 46,163 |
| Median / p95 / p99 | 22,11 / 1.030,47 / 1.677,43 ms |
| Errors<1% / checks>99% | Đạt |
| p95<1.000 ms | Không đạt |

K6 đã thoát; summary và stderr xác nhận thất bại threshold latency. Chưa ghi
exit code process độc lập; harness sẽ lưu sau crawl. `mixed-state.json` còn STARTED
theo lịch ghi của harness, không có nghĩa bài API vẫn chạy.

Raw metrics xác nhận cả ba lỗi là `scan_pages` HTTP404/SCAN_PAGE_NOT_FOUND
trong phút 13:30 local, không phải HTTP timeout. Login 150/150 không lỗi.
Chưa có nguyên nhân server đã xác minh cho ba 404. Endpoint p95:

| Endpoint | Requests | p95 ms |
| --- | ---: | ---: |
| auth_login | 150 | 1.051,79 |
| dashboard_summary | 5.704 | 115,55 |
| website_list | 5.674 | 105,59 |
| scan_list | 5.648 | 93,04 |
| scan_progress | 5.360 | 59,80 |
| scan_pages | 5.331 | 1.692,09 |

Nguồn: `150-scans/api-analysis.json`, `mixed-summary.json`, `mixed.jsonl` và
stdout/stderr cùng directory. API500 cũ p95 5.703,58 ms/errors 3,0023%; so sánh
này khác mức tải và khối lượng crawl, chưa đủ kết luận capacity hoặc tác động
riêng của patch. Không loại login, startup, 404 hoặc admission timeout.

Crawl còn chạy: telemetry 06:43:33 UTC ghi 146 RUNNING ở hai phía;
active-scope 13.453 SUCCEEDED/2.842 PERSISTING/127.737 QUEUED. Hai file polling
progress/failures chưa có sample; wrapper và collectors vẫn sống. Evidence
`150-scans/telemetry-live-0644.json`. Chưa có queue wait/event lag terminal,
cleanup, đối chiếu cuối hoặc kết quả toàn bài. Seed giữ, global unknown.

Kiểm lại 06:45 UTC: file progress đã có sample, mới nhất 06:44:39 UTC ghi
146 RUNNING/0 terminal, processed14.112, unobserved0 và totalsComplete=true;
scanPollingFailures rỗng. File failures vẫn 0 byte. Crawl chưa hoàn tất.

### Kết quả cuối 150 scan + 150 API — 03/10/2026, đối chiếu 08:40 UTC

**Không đạt toàn bài**: manifest gốc FAILED_ACCEPTANCE_CRITERIA, wrapper gốc
RECOVERY_UNVERIFIED giữ nguyên. Bốn admission timeout và API latency SLO là
các tiêu chí không đạt. Đối chiếu scoped cleanup bổ sung thành công; không sửa
state/manifest/cleanup-state gốc để che kết quả.

| Chỉ số | Kết quả |
| --- | --- |
| Yêu cầu scan / HTTP202 / timeout | 150 / 146 / 4 |
| Terminal Control và Crawler | 146 COMPLETED, 0 mismatch |
| Succeeded / failed pages | 146.000 / 0 |
| Requested pages | 150.000; thiếu4.000 do admission |
| Analytics pages / receipt page rows | 146.000 / 146.000, owner/scan khớp |
| Crawler first start→last finish | 13:29:57,935→15:29:06,703 UTC+7; 1h59m08,768s |
| Crawler throughput | 20,4231pages/s |
| Crawler accepted→started p95 | 4,64s |
| Control created→started p95 | 41,78s |
| Terminal finished→inbox processed p95 / max | 0,486s / 0,541s |
| Final outbox / inbox | 146DELIVERED / 146APPLIED; message/version khớp |
| Scoped queued / leased / persisting | 0 / 0 / 0 |
| Scoped pending/claimed/DEAD events / analytics | 0 / 0 |
| API requests / errors / p95 | 27.867 / 3(0,010765%) / 1.030,47ms |
| API errors / latency SLO | Đạt / không đạt; k6 exit99 |

Bốn website timeout không có scan/execution khi đọc cuối08:35:54UTC; HTTP
timeout vẫn thất bại, không retry và không gọi là150 scan hoàn tất. Ba API errors
là404SCAN_PAGE_NOT_FOUND ở pages, nguyên nhân chưa xác minh; login150 không lỗi.
Admission response-only p95698,63ms khác client elapsed p953.192,55ms, giữ cả hai.
API chỉ10phút đồng thời giai đoạn đầu crawl, không chạy liên tục cả hai giờ.

So sánh số quan sát với500 trước: pages/s19,52→20,42; Control queue p95
6h32m48s→41,78s; terminal event p9598,23min→0,486s; status mismatch36/500→0/146;
API p955,70s→1,03s/errors3,0023%→0,010765%. Tải150 nhỏ hơn500, không đủ
chứng minh capacity500/1.000 hoặc hiệu quả riêng của từng thay đổi.

Routes/hosts off và process wrapper/k6/test/local+remote collector đã thoát theo
proof bổ sung; stop-file có và telemetry đã thu hồi. Không có collector failure
lần này; không khẳng định mọi lần sau đều thoát đúng. Global DEAD/orphan PERSISTING
ngoài scope unknown. 150 seed websites còn ACTIVE; giữ private seed/DPAPI để kiểm
tra identity/timeout, không archive/xóa tài khoản trong lần đối chiếu này.

Diagnostic query tổng hợp đã có timeout10s/30s, lưu stderr; tách scoped executions,
latest events và analytics rồi đối chiếu đạt. Không gọi timeout đọc DB này là API error.
Evidence run directory trên: `final-analysis.json`, `terminal-db-proof-staged.jsonl`,
`crawler-terminal-proof.jsonl`, `closeout-proof.json`, `route-status-proof.json`,
`local-process-exit-proof.json` và `150-scans/{level-manifest,scans,cleanup-scans}.json`,
`150-scans/vps.jsonl`, `150-scans/api-analysis.json`. Runnable assert
`python tmp/load/analyze-runtime150-terminal.py` PASS.
Báo cáo lưu; mục tiêu1.000 còn chờ phạm vi, indexrevision1pending, Windows giữ bật.

#### Làm rõ bốn admission timeout — 03/10/2026, 11:10 UTC

Access logs Caddy hiện tại và archive ngày03/10 chỉ có146 POST admission trong
cửa sổ đo, đúng146 website IDs đã nhận; tất cảHTTP202, handler max502,83ms.
Bốn website timeout không có POST trong logs đã giữ và không có scan/execution
ở DB khi đối chiếu sau terminal. Thiếu correlation backend log không được coi
là chứng minh độc lập vì DEBUG admission logger chưa được xác minh/bật.

**Suy luận:** nghiêng về timeout khi lấy/thiết lập kết nối HTTPS trước HTTP
admission được quan sát, khi150 VU gửi cùng lúc. Bốn lỗi chạm timeout5s, code1050;
timing0 chỉ là thiếu completed phase, không phải elapsed0. Chưa xác định riêng
DNS/TCP/TLS/đường truyền; chưa có bằng chứng để gán lỗi cho ClickHouse hoặc logic
tạo scan. Successful requests có blocked p95 khoảng2,36s/TLS p95 khoảng2,33s.
VPS CPU mẫu quanh burst97,6% chỉ là tương quan; không chứng minh nguyên nhân.

Evidence: `admission-log-proof.json`, `admission-diagnosis.json`; không đổi runtime,
timeout/SLO, không retry hoặc chạy tải mới. Diễn giải theo
[k6 error codes](https://grafana.com/docs/k6/latest/javascript-api/error-codes/) và
[tracer v2.2.0](https://github.com/grafana/k6/blob/v2.2.0/lib/netext/httpext/tracer.go).

#### Đối chiếu command và thử nghiệm transport — 2026-10-03

Query read-only scoped lượt150 lúc12:26UTC xác nhận146 command DELIVERED, một
attempt mỗi command và146 crawler inbox APPLIED, message/aggregate/version/owner
khớp. Control outbox created→delivered p9519,9695s; created→crawler accepted_at
p9519,88675s có giới hạn so sánh clock và timestamp trước commit. Không tách được
outbox wait/HTTP/DB bằng evidence hiện có. Bốn admission timeout giữ nguyên.

Thử nghiệm **transport cục bộ tổng hợp**, inbox mô phỏng20ms, 27 mẫu tại150/300/500
command: mẫu500 trung vị p95 HTTP tuần tự22,098s, HTTP4 sender5,549s và RabbitMQ4
consumer4,232s. Đây không phải kết quả500 scan hoặc API500 VU. Publisher confirms
được đo riêng và không coi là consumer acceptance. Broker4.2.0 thật đã qua kiểm
tra mandatory return, redelivery sau đóng consumer, dedup/collision mô phỏng,
dead-letter và persistent command qua restart container.

Xem [báo cáo đánh giá](PERFORMANCE_DISPATCH_EVALUATION_2026-10-03.md) và
[ADR-017 Proposed](../adr/ADR-017-rabbitmq-command-transport-evaluation.md).
Không thay production hoặc kết quả/SLO gốc; chưa có adapter RabbitMQ trong runtime.
