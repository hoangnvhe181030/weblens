# Tối ưu thời gian chờ scan và độ trễ API

## Đính chính sau audit đầy đủ — 2026-10-03 02:22 giờ local (UTC+7)

Đã đọc có giới hạn đúng 500 scan ID ở cả hai DB và latest outbox/inbox records.
**Crawler: 500 COMPLETED, 500.000 succeeded/expected/published; Control Plane:
464 COMPLETED, 36 CANCELLED, 464.000 succeeded/published.** Đủ 500 event hoàn tất
đã DELIVERED với version khớp Crawler; inbox ghi 464 APPLIED và 36 IGNORED_STALE.
36 projection bị hủy có remote_execution_version=0. Vì vậy câu “36 scan chưa
bắt đầu” ở cập nhật trước chỉ mô tả projection, không đúng với execution Crawler.

Crawler first start10:10:05,813 UTC, last finish17:17:00,041 UTC: wall25.614,228s,
**19,5204 pages/s**, hoàn tất trước deadline8h. Số15,7160 pages/s trước đây dựa
timestamps Control Plane khi apply event và không phải throughput thực của worker.
Queue thực Crawler p9523.568,34s; terminal event delivery p955.893,59s/max6.015,51s.
Source đã xác nhận cancellation QUEUED chuyển local sang CANCELLED ngay và
terminal local chặn projection đến muộn. Sự lệch trạng thái là lỗi đã đối chiếu;
publisher gửi tuần tự là candidate cần đo, chưa phải toàn bộ nguyên nhân event lag.

API3,0023% lỗi/p955.703,58ms, admission elapsed p953.908,15ms vẫn không đạt.
Manifest FAILED và wrapper RECOVERY_UNVERIFIED giữ nguyên; không đổi outcome
bằng kết quả Crawler tốt hơn. Published counters chưa là query physical
ClickHouse độc lập theo owner/scan. Global DEAD/orphan PERSISTING vẫn unknown.
Không sửa runtime/DDL hoặc phát bài mới trong audit. Chi tiết đầy đủ và yêu cầu
đánh giá độc lập: `WEBLENS_500_SCAN_REVIEW_2026-10-03.md`; evidence và analyzer tại
`tmp/load/diagnosis-500-20261002/full-run-audit/`. UTF-8 và assertions đã kiểm.

## Cập nhật 2026-10-02 13:43 UTC: tiếp tục chẩn đoán theo quyền người dùng

Người dùng đồng ý tiếp tục hoàn tất lượt500, đo query/pool, sửa theo bằng chứng,
kiểm chứng tải nhỏ rồi thử lại500. Wrapper30516 vẫn RUNNING; progress13:41:46UTC
ghi193COMPLETED/14RUNNING/293QUEUED,198.784processed,2polling failures cũ,
ba health200/UP. Giữ code/service/config/worker và harness frozen trong lượt.
Chưa có terminal cleanup và chưa chạy bài mới; mục tiêu1.000 còn chờ phạm vi.

Phân tích mixed.jsonl theo phút bổ sung: tất cả1.947HTTP failures nằm trong
hai phút đầu tính theo timestamp metric hoàn tất request. Sau cutoff10:12:13UTC,
56.428request có0errors nhưng p95 vẫn4.802,20ms; scan_pages11.358request,
mean4.611,21ms/p95 5.658,81ms. Các API khác p95 khoảng1.020–1.082ms.
Đây là phân tích sau lượt API để tách startup/login surge và read latency;
không loại hai phút đầu khỏi outcome, không đổi SLO hoặc nói API500 đã đạt.
Tất cả952login failures xảy ra trước cutoff; chưa khẳng định lỗi login chỉ do
bcrypt hoặc tự giảm strength12/tắt authentication để làm đẹp benchmark.

Inspection driver clickhouse-go v2.43.0: rows.Next trảfalse sẽ Close; goroutine
query drain xong sẽ release connection. Chưa có bằng chứng defer rows.Close
trong ListPages làm rò connection; không thêm một bản sửa Close không có căn cứ.
Timeout pool5s/MaxOpen10 và sink dùng chung vẫn được xác nhận từ source deploy.

Một execution thuộc lượt đang chạy được đọc bằng scan_id có statusQUEUED,
analytics_expected_count0/published0. EXPLAIN indexes=1 read-only cho count trên
page_metrics_current theo owner/scan vẫn chọn11/11parts và11/111granules;
primary key có pruning, không phải full-table scan. EXPLAIN không thực thi report
và không cho biết latency under load. Không thêm index/schema/grant/config.

Phương án nhỏ nhất cần triển khai và kiểm chứng **sau terminal cleanup**:

1. Sau service authentication, GetReportState theo owner/scan và đầy đủ filter/
   cursor validation, trả Items=[]/Summary0 với state/watermark thật khi expected
   và published cùng0; tránh gọi ClickHouse khi chưa có accepted analytical facts.
   Không chuyển REPORT_NOT_FOUND, DB/query lỗi hoặc counter bất thường thành200.
2. Test owner isolation, invalid filter/cursor, zero counters, counters bất thường,
   ingestion đang tăng và đường non-empty; giữ FINAL/dedup, freshness và API shape.
   Expected count tăng trong cùng transaction với analytics staging trước sink,
   nhưng phải xác minh race/snapshot semantics trước dùng fast path.
3. Bổ sung timing các bước state/pages/findings/summary và pool stats vào bản đo
   cần thiết; dùng lại khả năng driver Stats, không thêm dependency. Nếu non-empty
   vẫn chậm thì mới chọn giảm query hoặc isolation pool sau bằng chứng tiếp theo.
4. Kiểm chứng tải nhỏ sau cleanup, giữ tổng errors/SLO/timeout/identity; chỉ thử
   lại500 khi đo nhỏ đủ bằng chứng. Tiếp tục đối chiếu202not-found và lease stale.

Proof: `tmp/load/diagnosis-500-20261002/report-followup-diagnosis.json`,
`report-selected-scan.json`, `report-empty-scan-plan.json`; số tổng errors theo
phút đã assert bằng1.947. Chưa triển khai candidate hoặc tuyên bố tăng capacity.
Automation vẫn PAUSED; wrapper hiện có tiếp tục crawl và publish report độc lập.

## Cập nhật 2026-10-02 10:26 UTC: API500 kết thúc, crawl vẫn chạy

Lượt `worker64-500-after-claimfix` đã nhận đủ 500 HTTP202 và 500 scan ID
riêng biệt. Admission HTTP p95 99,554ms, nhưng elapsed client p95 3.908,15ms
vẫn vi phạm SLO: blocked p95 3.852,709ms, TLS p95 3.660,819ms, HTTP waiting
p95 98,255ms. Blocked gồm các bước kết nối chồng nhau, không cộng các p95;
chưa xác định TLS chậm nằm ở máy phát tải, đường truyền hay Caddy.

API500 bắt đầu 10:10:13 UTC, kết thúc request cuối 10:20:17 UTC:
64.850 request, 1.947 lỗi (3,0023%), p95 5.703,582ms. k6 đã thoát và ghi
threshold failure; mixed-state còn STARTED vì wrapper chỉ cập nhật sau crawl.
Không coi mixed-state đó là bằng chứng API vẫn chạy. So với lượt500 cũ,
error rate và p95 giảm nhưng vẫn không đạt dưới1% và dưới1.000ms.
952 lỗi login/1.452 request login; 995 lỗi API khác. Trong API khác có
792 HTTP_0, 202 SCAN_PAGE_NOT_FOUND, 1 CRAWLER_REPORT_UNAVAILABLE.
Scan_pages: 12.675 request, 421 lỗi, p95 6.772,280ms; các API còn lại p95
1.336–1.985ms. Giữ mọi lỗi; chưa giải thích đủ nguồn của 202 lỗi not-found.

Counter stage được đối chiếu bằng hiệu số trong khoảng sampler kết thúc
10:10:10 đến 10:20:22 UTC, bao cửa sổ API: report remote 12.675 lần,
mean 4.119,933ms; authorization mean 5,732ms. Login password mean1.752,796ms,
session566,783ms, lookup171,392ms. Đây là mean từ counter, không phải p95;
login counter có thể chứa request vẫn hoàn tất sau khi client timeout.
41 mẫu service Running/listener PID8612; Tomcat busy median/p95/max100.
Sampler tuần tự mất median8,14s/max72,36s khi quá tải, nên không dùng timestamp
đầu mẫu như một snapshot đồng thời hoặc suy liên tục service ổn định.
Sau API, mẫu10:22:53 UTC ghi Tomcat busy2, Hikari pending0.

**Điểm nghẽn API đã xác nhận:** log có 48 page-report và 4 summary-report
`clickhouse: acquire conn timeout`. Source đúng commit đang deploy có
MaxOpenConns10/DialTimeout5s, cùng analyticsSink cấp cho report API, analytics
writer và readiness. Điều này chứng minh chờ pool ClickHouse, chưa chứng minh
chỉ tăng pool là đủ hoặc truy vấn nào giữ connection lâu nhất. Source deploy
chưa có report stage timing của các thay đổi sẵn có trong checkout chính.
Probe read-only system.processes bị code497 ACCESS_DENIED; không tăng quyền.
Hướng tiếp theo sau cleanup là đo query/pool riêng và kiểm chứng giảm tranh
chấp đọc/ghi; giữ tính đúng FINAL, ownership và freshness, không tự thêm DDL.

Log trong API window còn 149 analytics acknowledgement `lease is stale`,
17 event acknowledgement `lease is stale`, 2 event delivery timeout và
2 command consumption lỗi timeout/cancel. Không coi các lỗi này là mất dữ
liệu đã xác nhận hoặc xóa khỏi kết quả. Cần đối chiếu terminal/identity thật.
9.992 page claim trong các interval engine, không claim/fetch/build/commit
errors; ba interval10:15:55–10:16:55 giữ568–580 claim/30s (~19/s).
Đây là tốc độ claim, không phải số trang succeeded đã công bố.
Telemetry10:22:53 UTC: RUNNING24/QUEUED476; SUCCEEDED9.471/PERSISTING4.318
trong scope active executions, analyticsUnpublished4.318. Progress Control
Plane lúc10:22:08 chỉ1.471 processed; có độ trễ giữa các projection, không
trộn các nguồn thành một throughput. Readiness Crawler503 trong API, UP sau
API; không dùng health/resource guard để hủy lượt theo quyền người dùng.

WrapperPID30516 vẫn chạy, chưa terminal/cleanup/routes off. SamplerPID5444
giới hạn30phút vẫn chạy; bản snapshot API đã tải về. Reports chỉ lưu kết quả
API và chẩn đoán giữa lượt; không công bố outcome cuối hoặc global recovery.
Automation vẫn PAUSED, không tuyên bố giám sát15phút tự động đã bật.
Giữ code/runtime/config frozen cho đến khi lượt500 kết thúc.
Không phát lượt1.000 khi phạm vi còn chưa rõ và không shutdown.

Proof tái lập: `tmp/load/diagnosis-500-20261002/analyze-retry-api.py`,
`claimfixed500-api-analysis.json`, `claimfixed500-admission-analysis.json`,
sampler/crawler API-window snapshots và `claimfixed500-post-api-snapshot.jsonl`.
Analyzer đã đối chiếu tổng request/lỗi với k6 summary và lưu SHA-256 nguồn.

Recheck10:29UTC: samplerSSH PID5444 đã thoát, remote process0; mẫu cuối kết
thúc10:28:48UTC. Full sampler đã tải về `auth-stage-500-final.jsonl`, proof
`auth500-exit-proof.json`. Wrapper30516 vẫn RUNNING. Progress10:28:49UTC:
24RUNNING/476QUEUED,6.990processed,0terminal; ba health200/UP. Đây là progress
projection Control Plane, không phải terminal throughput hoặc cleanup proof.

## Cập nhật 2026-10-02 10:00 UTC: bài 25 hoàn tất, đã thử lại 500

Bài `worker64-claimfixed25` đã hoàn tất đủ 25/25 scan COMPLETED, 25.000
succeeded/0 failed pages; observed wall 1.510,258 giây (khoảng25,17 phút),
16,5535 trang/giây. Admission25/25 HTTP202, p95 HTTP192,63ms, elapsed243ms.
API25VU10m: 4.767 request, 0% HTTP errors, p95 662,14ms, k6 exit0.
25 scan ID riêng biệt, không có identity chưa xác minh; terminal cleanup
verified, hai routes off, collector/test exit, private seed/DPAPI đã xóa.
Global recovery vẫn false vì DEAD/orphan PERSISTING chưa xác minh.

Manifest gốc vẫn FAILED_ACCEPTANCE_CRITERIA, stopReason duy nhất
`generator_cpu_max_gte_85_percent` (CPU generator max91%). Đây là quy tắc
acceptance CPU còn sót lại trong harness dù người dùng đã bỏ operational
guards. Không sửa lại outcome cũ. Harness cho các lượt tiếp theo đã bỏ bốn
resource acceptance gates khi SkipOperationalGuards=true, giữ số đo và
HTTP/timeout/SLO/identity/cleanup. Smoke đã kiểm strict profile vẫn trả đủ
4 lý do khi CPU/RAM cao, waived profile không trả resource stop reason.

Queue wait p95 của bài25 vẫn 846,20 giây, max1.066,87giây; median1,77giây.
Hai scan cuối bắt đầu muộn. Bản sửa đã loại vòng tra inbox lặp theo mỗi trang,
nhưng thứ tự oldest-first vẫn tạo độ lệch chờ; không tuyên bố fairness đã sửa.
API scan_pages p95 703,78ms; các API dashboard/list/progress p95 khoảng19–24ms.
Metric login hiện có: lookup mean~4,4ms, password~408,5ms, session~13,0ms;
report remote mean~548,3ms. Đây là cumulative counter sau lần restart Backend
trước đó, không phải riêng API500 cũ hoặc bằng chứng nguyên nhân lỗi500.

Sau cleanup, wrapper `worker64-500-after-claimfix` PID30516 bắt đầu 09:58:52 UTC,
500 tài khoản riêng ×1.000 trang, worker64/host2/delay1s không đổi, API10m,
crawl hạn28.800s, SkipOperationalGuards và ContinueVerifiedAdmissions.
Crawler SHA-256 `586a1b84926579748f9dfa97e37761aee274328ed600cb44afa1a81b9e165717`;
Backend/collector giữ SHA-256 trước đó. Chưa có kết quả admission/API/crawl500.
State: `tmp/load/phase8-scheduled-state-worker64-500-after-claimfix.json`;
active proof: `tmp/load/phase4-500-after-timing-active-run.json`.

Sampler read-only bổ sung PID5444, tối đa30phút/interval5s, đo login lookup/
password/session, report authorization/remote, Tomcat busy, service/listener8080.
Thử live60s đã kết thúc, đủ5stage available, service Running/listener PID8612;
observer khoảng1,2GET/s ngoài traffic benchmark. Không in token hoặc mật khẩu.
Proof/process paths: `tmp/load/diagnosis-500-20261002/auth500-process.json`.
Wrapper500 dùng PublishReports để append hai báo cáo theo manifest/cleanup/proof
khi kết thúc, UTF-8 checker đi kèm; global unknown không đổi thành recovery sạch.
Automation đã cập nhật prompt nhưng giữ trạng thái PAUSED có sẵn.
Không phát workload chồng, không thay runtime trong lượt500, không chạy1.000
khi phạm vi còn chờ câu trả lời và không shutdown.

### Điều cần hiểu khi nhận bản sửa

LIMIT sau enrichment có thể khiến truy vấn con chạy hàng trăm lần; giới hạn
candidate trước enrichment giữ cardinality một trang. CTE vẫn khóa page bằng
FOR UPDATE/SKIP LOCKED trong cùng transaction, giữ fencing và ownership.
Partition predicate giảm chi phí lập plan. Query explain là bằng chứng cục bộ;
capacity và fairness phải đọc từ run đầy đủ, không suy từ một mẫu nhanh.

## Cập nhật 2026-10-02 09:30 UTC: sửa bottleneck chọn trang, đang kiểm chứng

Đã xác định nguyên nhân gốc cụ thể trong truy vấn thứ ba của `ClaimPage`:
JOIN LATERAL tra correlation trong `inbox_messages` trước sort/LIMIT trang.
EXPLAIN ANALYZE read-only cho một execution đang chạy: 524 trang candidate,
524 lần seq scan inbox, mỗi lần loại 4.077 dòng, 55.020 shared hit blocks riêng
cho inbox; planning 70,837 ms, execution 521,027 ms. Chỉ thêm partition predicate
giảm planning xuống 1,244 ms nhưng execution vẫn 548,821 ms, nên không đủ.

Bản sửa chọn và khóa một trang trong CTE MATERIALIZED trước enrichment,
sau đó mới tra command correlation; truyền retention_month của execution để
prune partition ngay khi lập plan. Giữ owner/website/scan identity, thứ tự ưu tiên,
SKIP LOCKED, fencing và giới hạn host. Mẫu explain không lấy lock trên cùng dữ
liệu sống: inbox chỉ chạy một lần, planning 17,607 ms, execution 20,306 ms.
Đây là mẫu query, không phải throughput end-to-end hay capacity 500/1.000.
Proof: `tmp/load/diagnosis-500-20261002/page-plan-comparison.json`,
`page-plan-candidate.json` và các SQL read-only cùng thư mục.

Commit `ceb3a767b36d91a65725f8791839eb7fceb9727f`, binary SHA-256
`586a1b84926579748f9dfa97e37761aee274328ed600cb44afa1a81b9e165717` đã cài
sau khi bài baseline kết thúc và routes off/active executions 0 được xác minh.
Không đổi schema/index/worker/host delay. Test workflow thật trên PostgreSQL 18
local riêng đã passed 8 nhánh: identity/idempotency, cancellation fencing,
reclaim generation, lock order claim/cancel và heartbeat/cancel, host slots,
backpressure và structural caps. PostgreSQL test PID 32496 đã dừng. Không chạy
DDL integration trên production; race detector vẫn chưa chạy do CGO tắt.

Bài baseline 25 kết thúc FAILED_ACCEPTANCE_CRITERIA do hạn 900 giây:
25 admission HTTP202, 1 COMPLETED/24 CANCELLED, 25 terminal; harness ghi 3.779
processed/25.000, 4,1758 trang/giây observed. API 25VU 10 phút: 4.786 request,
0 HTTP errors, p95 641,87 ms; admission p95 430,28 ms. Hai routes off,
collector/test đã thoát, private seed được cleanup. Global recovery vẫn false
vì DEAD/orphan PERSISTING unknown, không vì scope 25 còn active.

Wrapper `worker64-claimfixed25` PID 31200, run
`tmp/load/phase8-worker64-claimfixed25-25x1000-20261002T092648Z` đang kiểm
chứng cùng 25 tài khoản × 1.000 trang, API 10 phút, crawl tối đa 3.600 giây.
Worker64/host2/delay1s giữ nguyên. Cửa sổ 09:27:55–09:28:25 UTC: 654 claim
trong 30 giây, tổng claim 29.941 ms, không claim/fetch/commit errors; hai cửa
sổ kế tiếp 500 và 488 claim/30s. Mẫu progress 09:29:17 ghi 23 RUNNING,
2 QUEUED, 1.446 processed. Chưa kết luận lượt nhỏ đạt hoặc phát tải chồng.
Automation đã cập nhật mô tả mới và giữ nguyên trạng thái PAUSED hiện có.

## Cập nhật 2026-10-02 09:10 UTC: chẩn đoán và bài thử 25 tài khoản

Người dùng đã đồng ý tiến hành chẩn đoán, sửa điểm nghẽn có bằng chứng và
kiểm tra bằng tải nhỏ trước khi thử lại 500. Log retained đã được sao chép
read-only, đối chiếu SHA-256 và phân tích offline bằng
`tmp/load/diagnosis-500-20261002/analyze.py`; kết quả tái lập trong `analysis.json`.

- Backend có đủ 500 cặp correlation admission đã commit: body median 18,57 ms,
  p95 67,03 ms; call median 139,83 ms, p95 1.770,48 ms. Khoảng chênh call/body
  bao gồm transaction proxy và chưa thể gán riêng cho chờ connection DB.
- Caddy ghi 80 EOF và 186 connection-refused tới Backend trong khoảng
  19:19:32–19:20:27 UTC, cùng 44 incomplete response. Log Backend/wrapper
  không cho thấy restart trong cửa sổ này. Access log sớm đã rotate; chưa kết
  luận Backend crash hoặc nguyên nhân socket từ các dòng lỗi này.
- Crawler có 12.179 analytics batch: median 6 trang/batch; write median
  1.488 ms, acknowledgement median 685 ms, total median 2.316 ms. Không có
  log claim-page-failed hoặc chuyển trạng thái backpressure trong cửa sổ run.
  Đây là thời gian sink đo được, chưa chứng minh sink là điểm nghẽn đầu vào.

Source Crawler đang deploy được xác minh là `9e87e8b`, binary modified=false;
đã tạo worktree riêng tại đúng base để giữ thay đổi có sẵn ở checkout chính.
Commit `b1d1f88dbbbf30ef3ad0ffae56504c7c221d7cd5` bổ sung timing opt-in tổng hợp
claim/fetch/build/commit, số slot đang dùng và backpressure mỗi 30 giây.
Không đổi SQL, worker, giới hạn host hay retry. Bản đo SHA-256
`a936806611dd9ba08c64a4ee67077e595ec3f9e1feb9f6e8bc8f6092f27d686d`
được cài bằng patch manager có hash guard/rollback; runtime xác nhận worker 64,
host concurrency 2, host delay 1 giây, poll 250 ms. Không có active execution
trước cài; global recovery vẫn chưa xác minh.

`go test ./...` passed; DB integration cần URL riêng nên chưa chạy trên DB thật.
Một assertion timing loopback được sửa để chấp nhận 0 do độ phân giải đồng hồ
Windows, vẫn yêu cầu ConnectObserved. Race detector chưa chạy vì CGO tắt.
Patch-manager smoke (gồm named Crawler, rollback, hash guard), harness 500
identity/cleanup và k6 smoke 25/50/500 đều passed; không dùng mạng trong smoke.

Wrapper `worker64-diagnostic25` PID 14216 bắt đầu 09:06 UTC: 25 tài khoản riêng,
mỗi người tạo scan 1.000 trang, API 10 phút, hạn quan sát crawl 900 giây.
Run `tmp/load/phase8-worker64-diagnostic25-25x1000-20261002T090605Z` đang chạy.
Đây là bài tái hiện có giới hạn thời gian để chọn bản sửa; hết hạn có thể hủy
scan và vẫn ghi acceptance fail thật. Cửa sổ 09:07:23–09:07:53 UTC: 96 claim
chiếm tổng 29.767 ms, 96 fetch tổng 549 ms, peak active 2; chưa có lỗi ở các
stage. EXPLAIN ANALYZE read-only trên truy vấn eligibility không lấy lock,
giới hạn statement 2 giây/lock 500 ms: planning 100,086 ms, execution 9,277 ms.
Chưa quy toàn bộ claim cho truy vấn đầu hoặc cho lock từ một mẫu explain.
Giữ đối chiếu identity/terminal và route cleanup; không phát lượt 500/1.000
trong khi bài nhỏ chạy. Phạm vi 1.000 còn chờ câu trả lời; review index revision
1 vẫn pending. Chưa đủ điều kiện shutdown.

## Cập nhật 2026-10-02 03:28 UTC: lượt 500 kết thúc, không đạt

Run `worker64-500-after-timing-retry` bắt đầu 2026-10-01 19:07:43 UTC và kết
thúc 2026-10-02 03:23 UTC. Harness ghi `FAILED_ACCEPTANCE_CRITERIA`, wrapper
`RECOVERY_UNVERIFIED`; PID 19376 đã thoát. `primaryFailure` của wrapper là
`RuntimeException` tại dòng 119 khi wrapper nhận outcome không hoàn tất từ
harness. Đây là nhánh kiểm tra outcome; manifest không ghi exception gốc khác.
Không quy lỗi cho DB, logger hoặc service khi chưa có bằng chứng.

500/500 admission nhận HTTP 202, 500 scan ID riêng biệt, không có identity mới
chưa xác minh. p95 admission HTTP là 2.829,81 ms; p95 elapsed từ phía client
3.374,1 ms, đều vượt ngưỡng 1.000 ms. Cửa sổ API 500 VU chỉ kéo dài khoảng
19:19–19:29 UTC: 63.852 request, 2.433 lỗi (3,8104%), p95 6.275,94 ms,
p99 10.000,40 ms. Trong 2.433 lỗi có 1.284 login và 1.149 API khác; API khác
gồm 828 `HTTP_0`, 226 `SCAN_PAGE_NOT_FOUND`, 95 `HTTP_502`. Giữ nguyên lỗi
HTTP 0/404/502 và threshold k6 thất bại. API không chạy suốt crawl tám giờ,
nên lượt này không chứng minh 500 người dùng liên tục hoặc capacity 1.000.

Đến hạn chờ scan khoảng tám giờ, 81 `COMPLETED` và 419 `CANCELLED` qua cleanup;
500/500 scan ID duy nhất đã terminal. Tổng 83.671 trang processed, 82.370
succeeded, 1.301 failed trên mục tiêu 500.000 trang. Harness tính 2,8985
trang/giây trong 28.866,695 giây quan sát; đây là tốc độ của lượt chưa hoàn
thành, không phải throughput của workload 500.000 trang hoàn chỉnh. Các
stopReasons còn có 5 lỗi polling sớm, admission/API SLO fail, non-completed
scan và mismatch tổng trang. Không khởi chạy workload tiếp trong khi phân tích.

Đối chiếu 500 bản ghi trong `500-scans/scans.json`: chỉ 85 scan có `startedAt`;
81 scan hoàn tất đủ 81.000 trang, 4 scan bị hủy sau khi bắt đầu xử lý 2.671
trang, còn **415 scan bị hủy khi chưa bắt đầu và đã xử lý 0 trang**. Từ 20:00
đến 02:59 UTC, mỗi giờ chỉ có khoảng 6–11 scan mới bắt đầu. Đây là nguyên
nhân trực tiếp khiến phần lớn scan không hoàn tất trước hạn: hàng đợi không được
phục vụ đủ nhanh. Nó chưa xác định nguyên nhân gốc của tốc độ claim/dispatch.
Code tại release commit `9e87e8b` có một dispatcher gọi `ClaimPage` tuần tự,
và truy vấn chọn execution đủ điều kiện theo `accepted_at` cũ nhất. Cơ chế này
có thể gây chờ lâu cho scan mới; cần đối chiếu binary đang chạy và đo thời gian
claim, lease, fetch, persist theo cùng cửa sổ trước khi quy trách nhiệm cho nó.

Telemetry có 1.785 mẫu VPS và 4.121 mẫu generator; VPS CPU max 99,9%, RAM max
98,74%, Hikari pending max 0, timeout delta 0, Tomcat busy max 100, một
telemetry source failure. Các cực đại lấy mẫu không xác định nguyên nhân tốc
độ crawl thấp. `guardReason=null`: CPU/RAM cao **không** tự dừng test vì người
dùng đã bỏ guard. Không kết luận tăng pool hoặc thêm broker sẽ giải quyết được
bottleneck từ các cực đại này.

Phân tích read-only theo cửa sổ telemetry: trong 23 mẫu VPS khoảng 19:19–19:30
UTC, `tomcat.threads.busy` median 99/p95 100, còn Hikari pending bằng 0 ở
mọi mẫu. Đây là bằng chứng request threads bận trong cửa sổ API, chưa biết
chúng chờ ở tầng nào. Trong 1.723 mẫu từ 19:30 đến 03:20, queued scans median
456, running scans median 3, queued pages median 1.621; leased pages và
active host leases bằng 0 ở 93,5% mẫu, p95 cùng bằng 1. Hikari pending vẫn
0, Tomcat busy p95 2, CPU VPS median 31,4%. Mẫu cách quãng có thể bỏ sót
lease ngắn; chưa đủ để kết luận worker thực tế chỉ là 1 hoặc chọn điểm nghẽn
cuối cùng. Trước bài 1.000 cần đối chiếu Crawler dispatch/lease/fetch/persist
và lý do nhiều scan QUEUED, đồng thời tách nguyên nhân thread bận của Backend
trong cửa sổ API. Không tăng pool hay thêm broker chỉ dựa trên peak.

Cleanup proof ghi đủ 500 terminal, không còn scan ID; verifier 03:23:38 UTC
thấy active scan/execution và backlog trong phạm vi đã đo bằng 0, hai route
synthetic off, sáu service Running, ba health HTTP 200/body UP, WebLens browser
0. `globalRecoveryVerified=false` vì event DEAD và orphan PERSISTING ngoài
active executions vẫn chưa xác minh; wrapper `RECOVERY_UNVERIFIED` phản ánh
giới hạn proof đó. Private seed của **lượt này** đã được cleanup sau khi terminal
được xác minh; hai identity chưa xác minh của lượt cũ là phạm vi riêng.

Logger `com.weblens.scan.admission` đã trả về mặc định lúc 03:28:31 UTC;
Backend Running/health UP, JAR SHA-256 không đổi, config gốc khớp SHA-256.
Lần chạy script restore đầu từ chối vì bản sao diagnostic đã tồn tại; hash bản
sao, config hiện tại và backup đều được xác minh trước khi restore.
Proof: `tmp/load/phase8-worker64-500-after-timing-retry-500x1000-20261001T190749Z/manifest.json`,
`500-scans/cleanup-scans.json`, `cleanup-state.json`, `global-recovery-1.json`
trong cùng thư mục và `tmp/load/phase8-worker64-500-after-timing-retry-logger-restore.json`.

## Cập nhật 2026-10-01 19:08 UTC: lượt 500 mới đã bắt đầu

Người dùng xác nhận dự án cá nhân chấp nhận mất dữ liệu và cho phép bỏ backup,
cổng global recovery và guard RAM/CPU/health cho lượt đo tải này. Mục tiêu là
đo giới hạn hiện tại rồi tiến tới 1.000 người dùng hoạt động liên tục. Backend
JAR timing vẫn SHA-256 `924db7d2...`; admission logger DEBUG đã bật và health
HTTP 200/body UP trước khi bắt đầu.

Wrapper `worker64-500-after-timing-retry` PID 19376 bắt đầu 19:07:43 UTC với
500 tài khoản × 1.000 trang, worker 64, `-SkipOperationalGuards` và
`-ContinueVerifiedAdmissions`. State 19:07:49 UTC là `RUNNING`;
`operationalGuardsSkippedByUser=true`. Chưa có kết quả admission, API hoặc
crawl. Không phát workload thứ hai hay thay service/config trong lúc chạy.
Giữ timeout, HTTP failures, SLO và terminal cleanup thật; unknown identity
không đổi thành success. State:
`tmp/load/phase8-scheduled-state-worker64-500-after-timing-retry.json` và
`tmp/load/phase4-500-after-timing-active-run.json`.

## Cập nhật 2026-10-01 18:56 UTC: preflight lượt chạy lại bị chặn

Theo yêu cầu deploy và chạy lại, Backend timing candidate đã triển khai, nhưng
lượt 500 mới `worker64-500-admission-measurement` chỉ chạy `-PreflightOnly` và
trả `PREFLIGHT_BLOCKED` trước khi tạo tài khoản/website/scan hoặc bật route.
Ba health trong preflight HTTP 200/body UP; active scan/execution trong scope
đã đo 0, routes off. `globalRecoveryVerified=false` vì DEAD event outbox và
PERSISTING ngoài active executions còn unknown. Ngoại lệ bỏ backup/guard của
lượt trước không áp dụng cho lượt này; câu hỏi về ngoại lệ riêng đã gửi và
chưa có câu trả lời. Không có kết quả tải mới để công bố.

Logger admission DEBUG đã được bật thử và xác minh Backend khỏe, rồi trả về
mức mặc định sau khi preflight chặn; cấu hình XML gốc và JAR deployed đều
khớp hash. Bản JAR trước deploy vẫn ở thư mục patch để restore. Verifier cuối
18:55:46 UTC ghi Backend health HTTP 200, hai worker curl timeout 5 giây,
RAM 82,94%, sáu service Running và routes off. Không gán timeout là service
DOWN hoặc coi một mẫu health trước đó là ổn định dài hạn. Proof:
`tmp/load/postdeploy-admission-measurement-20261002.json`,
`tmp/load/phase8-scheduled-state-worker64-500-admission-measurement.json`.

## Cập nhật 2026-10-01 18:43 UTC: triển khai bản đo admission, chưa chạy tải lại

Đã tạo candidate riêng `codex/performance-admission-measurement` commit
`56b0660e08bd0260d98808067dfb0bb999038bbb` từ đúng bản Backend production
`9042d075acbb0dfaf06217c0c5802038b93520a6`. Candidate chỉ thêm timing
admission ở `ScanController`/`ScanService` và test liên quan. `mvnw verify` đạt
87 unit/security/architecture tests, không failure; 19 integration tests SKIPPED
vì Docker không có. Patch manager smoke 5/5 đạt, gồm named patch và rollback.

Đã deploy Backend candidate JAR SHA-256
`924db7d2cf9930cb32cde21c3d503846ee6c04cbeecaad8ae3222ed05c8d8326`
lên VPS. Helper đối chiếu hash cũ `34b486d5...`, sao lưu nguyên JAR cũ rồi
khởi động và kiểm health trước khi ghi manifest tại
`C:\ProgramData\WebLens\performance-fixture\runtime\admission-timing-20261002\manifest.json`.
Sau deploy hash hiện hành và backup đều khớp; sáu service Running. Verifier
18:40:51 UTC: Backend/Crawler/Capture HTTP 200/body UP, RAM 67,27%, routes
synthetic off, active scan/execution và backlog trong scope đã đo bằng 0.
`globalRecoveryVerified=false`: DEAD outbox và orphan PERSISTING còn chưa xác minh.
Tại mẫu 18:40, logger timing vẫn ở mức INFO và chưa có stage measurements production.

Lúc 18:51 UTC đã bật `com.weblens.scan.admission=DEBUG` qua một env riêng của
Backend service. Cấu hình trước đổi được lưu và đối chiếu SHA-256; Backend sau
restart HTTP 200/body UP, hash JAR giữ nguyên. Lần thử cấu hình đầu gặp lỗi xác
minh XML, lần kế tiếp có health check IWR đọc sai body nên tự rollback; đã sửa
parser và lần cuối được xác minh bằng curl/body UP. Hai identity 334/356 của
lượt cũ được đọc lại đúng owner lúc 18:51:58 UTC, lịch sử vẫn 0; vẫn là
`NOT_OBSERVED_NOT_PROVEN_ABSENT`, private credentials giữ nguyên. Stage log chỉ
có ý nghĩa sau request mới, không suy kết quả load từ việc bật logger.

Verifier trước deploy 18:37 UTC đã ghi hai worker health curl timeout 5 giây;
đây là failure thật của mẫu đó, dù mẫu sau deploy trả 200. Không suy timeout cũ
đã được chữa hoặc production ổn định dài hạn. Lượt tải mới **chưa chạy**. Ngoại
lệ bỏ backup/guard trước chỉ áp dụng lượt cũ; đã hỏi riêng cho lượt 500 này và
đang chờ trả lời. Không tự bỏ cổng recovery/health hoặc mặc định có 500.000 trang.
Proof: `tmp/load/postdeploy-admission-measurement-20261002.json`.

## Cập nhật 2026-10-01 18:08 UTC: chẩn đoán kết nối và sửa local admission/harness

Theo yêu cầu khắc phục, đã đối chiếu raw k6 của lượt `20261001T093718Z`
với access log Caddy bằng thao tác chỉ đọc. Hai identity 334/356 có status 0,
HTTP duration 0, connecting khoảng 1.031 ms, sending/waiting/receiving 0.
Request timeout thực là **5 giây**; `maxDuration=30s` là giới hạn scenario.
Trong cửa sổ 09:45–09:51 UTC, Caddy ghi 498 admission POST, tất cả HTTP 202;
p95 thời gian proxy 2.032,68 ms, max 2.502,92 ms. Không tìm thấy admission POST
cho hai website còn thiếu. Bằng chứng phù hợp với lỗi khi thiết lập kết nối trước
HTTP được ghi log; chưa xác định nguyên nhân mạng/TLS cụ thể, chưa chứng minh hai
scan không commit. Không quy hai timeout này cho lock/SQL/pool/report.
Evidence: `tmp/load/phase8-after-auth-report-connection-diagnostic-20261001.json`.

Các sửa local:

- k6 ghi `scan_admission_elapsed` bằng đồng hồ trước/sau POST cho mọi attempt,
  gồm timeout. `scan_admission_duration` chỉ nhận HTTP response status > 0,
  tránh đưa transport duration 0 vào latency. Giữ request timeout 5 giây,
  threshold cũ và lỗi thật; thêm threshold cùng mức cho elapsed. Không replay POST.
  Lưu transport error, blocked/connect/TLS/send/wait/receive trong observation.
- Harness lưu UUID correlation trong request identities trước admission và gửi
  cùng UUID tới Backend. Parser nhận cả format cũ/mới, từ chối diagnostic hỏng.
- Tùy chọn riêng `-ContinueVerifiedAdmissions` cho phép quan sát crawl đã xác
  minh và chạy API với đủ tài khoản yêu cầu dù một số admission chưa xác minh
  hoặc threshold thất bại. Người chưa có scan chỉ đọc dashboard/websites/history;
  không gửi route scan với ID null. Mặc định strict giữ nguyên. Zero verified scan,
  identity sai hoặc k6 exit khác 0/99 vẫn chặn. Tùy chọn này không bỏ operational
  guards và không biến partial workload thành success: manifest giữ accepted,
  committedObserved, unresolved, API users có scan và mọi failure. Credentials chỉ
  được xóa sau đối chiếu terminal/cleanup đủ; mixed API vẫn có cửa sổ 10 phút,
  chưa phải API liên tục suốt crawl.
- Tái sử dụng instrumentation admission từ `044fa4f`/`15455ab` vào local Backend:
  logger `com.weblens.scan.admission` mặc định INFO không tạo timing/callback;
  DEBUG đo từng stage lock/validation/idempotency/quota/saveAndFlush/outbox/mapping,
  ghi kết quả transaction sau completion. Controller đo cả proxy begin/commit.
  Không đổi transaction, owner/quota/idempotency/outbox/SSRF; không log credential,
  key, user, website, URL hoặc SQL binds. Đây là stage elapsed, không phải phép đo
  SQL/acquisition riêng hay p95 Hikari.

Validation: 10/10 Backend tests (ScanService 6, ScanAdmissionTiming 4) đạt;
Node offline k6 check đạt; offline harness 500 identity trên Windows PowerShell 5.1
và PowerShell 7 đạt; primary-error diagnostic check đạt. Các mô phỏng không phát
tải hoặc gọi DB production. UTF-8 và diff check đạt. Proof/hash:
`tmp/load/performance-admission-harness-validation-20261001.json`.

Chưa deploy instrumentation hoặc chạy tải mới; chưa chứng minh cải thiện latency
production hay capacity 500 người. Bản production gần nhất vẫn `9042d075`, worker
64/host 2, pool 32/min 4. Hai identity cũ vẫn unresolved và private seed giữ nguyên.
Phase 3–6, global recovery DEAD/PERSISTING và review index revision 1 còn mở.
Trước phép đo production tiếp cần candidate riêng từ đúng production base, hash/
rollback và phạm vi validation được phép; ngoại lệ bỏ guard của lượt cũ không tự
áp dụng cho lượt mới. Không shutdown trong khi task sửa/validation đang thực thi;
câu hỏi phạm vi các task Codex trước shutdown vẫn chờ trả lời.

## Cập nhật 2026-10-01 09:57 UTC: lượt 500 sau deploy dừng không đạt tiêu chí

Run `worker64-500-after-auth-report` (`20261001T093718Z`) đã kết thúc.
Trong 500 admission, client quan sát 498 scan, hai request không xác minh được
commit; p95 tạo scan 2.062,00 ms, vượt ngưỡng harness 1.000 ms. Wrapper báo
`FAILED_ACCEPTANCE_CRITERIA` ở dòng 117 khi nhận outcome của harness, không phải
bằng chứng exception DB hoặc service. Mixed API `NOT_STARTED` vì admission chưa
được xác minh; không có số p95/error của API 500 người sau deploy.

Harness đã thu hồi 498 scan qua API và quan sát cả 498 ở `CANCELLED`; 5.308 trang
đã processed trước khi dừng, không phải 500.000 trang hoàn tất hoặc throughput
bền vững. Hai identity 334/356 được đọc lại đúng owner/website lúc 09:57 UTC:
lịch sử đều 0 scan. Đây là `NOT_OBSERVED_NOT_PROVEN_ABSENT`, không đổi thành
admission success hoặc xác nhận cleanup 500/500. Private seed/credentials còn
giữ để đối chiếu về sau. Routes synthetic đã off; verifier 09:51:35 cho ba health
HTTP 200/body UP, active/backlog trong scope đã đo 0, RAM 71,91%, nhưng
`globalRecoveryVerified=false` vì DEAD outbox và PERSISTING ngoài active
executions chưa đo. Wrapper vì vậy kết thúc `RECOVERY_UNVERIFIED` ở dòng 155.
Không chạy workload thứ hai hoặc suy capacity 500 người.

Artifacts: `tmp/load/phase8-worker64-500-after-auth-report-500x1000-20261001T093718Z/manifest.json`,
`cleanup-state.json`, `admission-reconciliation-followup.json`,
`500-scans/submission-summary.json`, `500-scans/cleanup-scans.json`,
`global-recovery-1.json` và `tmp/load/phase8-scheduled-state-worker64-500-after-auth-report.json`.

## Cập nhật 2026-10-01 09:37 UTC: lượt tải 500 mới đã bắt đầu

Người dùng cho phép bỏ backup và các guard vận hành riêng lượt 500 mới sau khi
preflight bị chặn. Wrapper `worker64-500-after-auth-report` bắt đầu lúc 09:37:11
UTC với `-SkipOperationalGuards`, worker 64, 500 tài khoản × 1.000 trang và API.
State `tmp/load/phase8-scheduled-state-worker64-500-after-auth-report.json`
đã ghi `RUNNING` và `operationalGuardsSkippedByUser=true`; run directory là
`tmp/load/phase8-worker64-500-after-auth-report-500x1000-20261001T093718Z`.
Tại 09:38 UTC mới ở bước setup credentials, chưa có admission hoặc kết quả tải.
Không khởi chạy workload khác hoặc đổi service/config khi lượt này đang chạy.
Ngoại lệ không duyệt DDL và không chứng minh global recovery sạch.

## Cập nhật 2026-10-01 09:34 UTC: triển khai bản sửa, lượt tải mới bị chặn trước admission

Theo yêu cầu mới, đã tạo commit riêng `9042d075acbb0dfaf06217c0c5802038b93520a6`
từ đúng nền production `9e87e8b0c95ea1791dcc4814793e45b1e391ca36`.
Chỉ đưa vào hai thay đổi Backend (login/report), adaptive polling Frontend và test
liên quan. Các thay đổi Crawler/Capture/infra đang có trong working tree khác
không nằm trong bản deploy. Backend JAR SHA-256
`34b486d53d09ad11594f264f2ec7f69f1d6cc289acdff0bd5ed909dc0ce09074`;
Frontend `index.html` SHA-256
`26857dafc509a49b95e545a322b22ad4b0160426e22af017bbd23ddb37c52e0d`.
Triển khai riêng Backend/Frontend lên release hiện tại; `release.json` vẫn ghi commit
nền, provenance của patch nằm trong hai manifest ở
`C:\ProgramData\WebLens\performance-fixture\runtime\auth-report-polling-20261001`
và `frontend-polling-20261001`. Bản gốc được giữ để restore. Không đổi schema,
grants, cấu hình pool hoặc worker.

Validation trên nền production: `mvn -q verify` đạt 79 unit/security/architecture
tests. Bốn `AuthenticationPersistenceIT` ban đầu SKIPPED do Docker Desktop lỗi;
sau đó chạy thật cả 4/4 trên PostgreSQL 18.4 tạm biệt lập, không failure/error/skip.
Đây không phải PostgreSQL 17 production, nên giới hạn tương thích còn lại được giữ
rõ. Frontend 36/36 tests, build/lint đạt. Sau deploy, hai mẫu verifier 09:33:10 và
09:33:30 UTC cho cả ba health HTTP 200/body UP, sáu service Running, RAM 66,40% và
66,50%, active scan/execution trong scope đã đo bằng 0, routes synthetic off;
Backend đúng hash mới. Frontend HTTP `/app/` và index hash được xác nhận.
Lần cài Frontend đầu gặp lỗi helper `File.Replace` trước khi đổi index; helper được
sửa và cài thành công ở lần kế tiếp, bản gốc không bị mất. Evidence:
`tmp/load/postdeploy-auth-report-polling-20261001.json` và manifest VPS.

Đã chuẩn bị nhãn workload `worker64-500-after-auth-report`, 500 tài khoản ×
1.000 trang + API như yêu cầu trước, nhưng `-PreflightOnly` 09:33:57 UTC trả
`PREFLIGHT_BLOCKED`. Chưa tạo account/website/scan, chưa bật route, chưa chạy k6.
`globalRecoveryVerified=false` vì event outbox `DEAD` và page `PERSISTING` ngoài
active executions vẫn chưa được xác minh. Scope đã đo có backlog/active bằng 0;
điều đó không giải quyết hai unknown trên. Waiver bỏ backup/guard của lượt 500 cũ
không áp dụng cho lượt mới. Evidence:
`tmp/load/phase8-scheduled-state-worker64-500-after-auth-report.json` và
`tmp/load/phase8-worker64-500-after-auth-report-preflight-1.json`. Review index
revision 1 vẫn pending; không chạy DDL hoặc đổi gate để bắt đầu tải.

## Cập nhật mới nhất — 2026-10-01 07:05 UTC: sửa local transaction, polling và diagnostic

Theo yêu cầu triển khai kế hoạch tối ưu, đã sửa các đường có bằng chứng và kiểm
thử local. Chưa deploy các thay đổi này hoặc chạy workload mới. Trạng thái production
gần nhất vẫn là proof 06:18 UTC bên dưới; không dùng build local làm hash production.

- `AuthenticationService.login`: transaction đọc trả snapshot credential bất biến;
  bcrypt chạy sau completion. Transaction ghi đọc lại user bằng lock hiện có, kiểm
  tra ACTIVE, version, password hash và normalized email rồi tạo session. Commit
  thất bại không trả credentials. `Propagation.NEVER` từ chối caller có transaction
  ngoài, tránh giữ connection của caller trong bcrypt. Register/refresh/logout và
  transaction scan admission/outbox không đổi.
- `ScanReportService`: authorize active user/scan owner trong transaction read-only
  ngắn, kết thúc trước HTTP Crawler và mapping. Các caller hiện tại là controller;
  caller có ambient transaction bị từ chối. Giữ owner-scoped upstream query,
  freshness, summary và lỗi 404/503 hiện có; không tạo cache hoặc thay schema.
- Metrics Micrometer hiện có: `weblens.auth.login.stage` với tag stage
  `lookup/password/session`; `weblens.scan.report.stage` với
  `authorization/remote`. Không tag user/scan/URL/credential. Thời gian lookup/session/
  authorization gồm transaction begin/commit/cleanup; không phải SQL hoặc acquisition
  riêng. COUNT/TOTAL_TIME là số tích lũy theo stage, gồm failed invocations; delta mean
  không phải p95. Collector production cũ chưa thu các stage mới; chưa upload helper
  hoặc sửa hash collector/verifier production.
- `useAsyncData` hỗ trợ enablement, khoảng polling theo dữ liệu và dừng request
  polling khi tab ẩn. Scan QUEUED đọc progress mỗi 10 giây, RUNNING 3 giây,
  CANCEL_REQUESTED 2 giây. Report không gọi khi QUEUED; overview 10 giây, tab evidence
  5 giây. Chuyển terminal tải lại report một lần rồi dừng, kể cả watermark chưa fresh;
  UI giữ freshness thật. Các sửa frontend có sẵn trong working tree được bảo toàn.
- Harness lưu `primary-failure.json` và manifest primaryFailure độc lập với cleanup;
  wrapper giữ primaryFailure và recoveryFailure riêng. Diagnostic giữ stage,
  exception/inner types, file/line, HTTP/code/correlation khi có; loại arbitrary
  message/body/credential. HTTP/transport polling failures được ghi JSONL và counts,
  giữ identity chưa quan sát, chỉ đọc tiếp ở lịch sampling thông thường. Không retry
  ngay hoặc xóa failure sau lần đọc thành công. Programming/orchestration failure
  vẫn throw; observation failure làm acceptance fail. Sample thiếu scan có
  unobservedScans/totalsComplete=false; không coi tổng thiếu là toàn workload.
  Đã dispose HttpResponseMessage sau khi đọc body.

Validation:

- `mvn -q package`: 78 unit/security/architecture tests, 0 failure/error, build đạt.
  Sau bổ sung assertion và IT, focused verify: 14 auth/report tests đạt; bốn
  `AuthenticationPersistenceIT` SKIPPED vì Docker daemon không hoạt động. Hai IT mới
  kiểm tra session commit và disable giữa lookup/session; chưa có proof PostgreSQL thật.
- Frontend: toàn bộ 36 tests đạt; sau sửa cuối, 7 hook/scan tests đạt; build/lint đạt.
- Diagnostic smoke và harness smoke 500 identity (471 ACK + 29 committed timeout)
  đạt trên Windows PowerShell và PS7, hoàn toàn offline. Mock host-version trong
  wrapper smoke được ghi rõ; wrapper thật vẫn yêu cầu PS7. Failure retained,
  ownership, terminal cleanup, EXPLAIN fail-closed và DPAPI đều được kiểm tra.
- UTF-8/diff check đạt. `tools/load/performance-failure-smoke-test.ps1` là check
  runnable mới; harness/scheduled scripts vẫn ở `tmp/load`, cần giữ cùng helper
  `tools/load/performance-failure-diagnostic.ps1` khi chuẩn bị lượt đo sau.

Các bước còn phụ thuộc bằng chứng: validation DB thật và đo pool 32 dưới workload
tương đương; queue-age/dispatch measurement trước thay concurrency; cache/index theo
query plan và review; broker ADR/benchmark trước RabbitMQ hoặc Kafka; ngân sách
connection trước thêm replica; API suốt crawl cho Phase 6. Bài mixed hiện vẫn cửa sổ
10 phút, chưa đáp ứng Phase 6. Không nâng các phần này thành hoàn tất từ unit tests.
Review monitoring index revision 1 vẫn pending; global recovery unknown, Phase 3–6 mở.

## Cập nhật mới nhất — 2026-10-01 06:18 UTC: pool Backend 32 đã áp dụng

Người dùng trực tiếp yêu cầu thay cấu hình sau phương án pool 32/minimum idle 4/
role limit 40. Đã thực hiện đúng phạm vi này trên VPS, không chạy tải mới.

- Env `WEBLENS_HIKARI_MAX_POOL_SIZE`: 10 → 32;
  `WEBLENS_HIKARI_MIN_IDLE`: 2 → 4. Round-trip so sánh text xác nhận chỉ hai
  giá trị này thay đổi, UTF-8 giữ nguyên; env hash trước
  `d49d55d0819d949d642761ea1e4052bb19665466f013f8a2027d18c6730bf2f7`, sau
  `55b4f668941ff78ac8dc1a3b9c3d895aa62e85d781943453097a2c1997bebcc1`.
- Role runtime của Backend: connection limit 15 → 40, vẫn không superuser.
  Chỉ ALTER ROLE CONNECTION LIMIT; không thay grants/schema/index. Metadata
  xác nhận max_connections 100, reserved 3 và tổng finite limits các role
  ứng dụng khác 40: còn 17 slot ngoài các budget này. Không suy đây là capacity
  hoặc nhu cầu đỉnh; tài khoản quản trị vẫn sử dụng ngân sách cluster.
- Chỉ restart `WebLensBackend` bằng service control, không cưỡng bức process.
  Java PID 9984 → 8864. Các service wrapper PID Crawler/Capture/Postgres/Caddy
  giữ nguyên; binary SHA Backend/Crawler gốc giữ nguyên. Worker vẫn 64/host 2,
  Tomcat max threads vẫn 100.
- Health startup UP lúc 06:16:40 UTC; các lần chưa sẵn sàng trong giai đoạn
  startup được lưu đủ, không sửa verifier/gate cũ. Metrics thực sau restart:
  Hikari max 32/min 4, active 0/pending 0; uptime khoảng 51 giây tại mẫu đó.
  Timeout counter 0 là counter của process mới, **không phải cải thiện so với
  counter 251 trước restart**. Probe độc lập 06:17:30 curl exit 0/HTTP 200/body UP;
  sáu service Running. Đây là xác minh cấu hình/health, chưa là stability dài hạn.

Evidence: `tmp/load/phase4-backend-pool32-change.json`,
`tmp/load/phase4-backend-pool32-followup.json`; script vận hành local
`tmp/load/phase4-set-backend-pool-32.ps1`. Rollback copy của env chứa secrets chỉ
giữ trên VPS với ACL như env gốc tại
`C:\ProgramData\WebLens\performance-fixture\runtime\backend-pool32-20261001T061541Z\weblens.env.original`;
không tải về local hoặc đưa vào public proof. Rollback đã chuẩn bị: khôi phục
hai env values 10/2, role limit 15 và restart Backend; chưa cần thực hiện.
Không tạo database backup; đây là bản lưu cấu hình để hoàn nguyên.

PowerShell parse và kiểm tra UTF-8 đạt; validation production là metrics thật,
PID mới, binary hashes giữ nguyên và health request. Chưa chạy lại workload 500,
chưa chứng minh hết timeout/SLO/capacity. Lỗi gốc harness vẫn mất, cần sửa giữ
primary exception trước lượt tiếp; review index revision 1 vẫn pending,
globalRecoveryVerified=false và Phase 3–6 còn mở.

## Cập nhật mới nhất — 2026-10-01 06:07 UTC: giới hạn DB role trước khi tăng pool

Trả lời yêu cầu cách tăng pool; chưa thực hiện thay cấu hình/restart/tải mới.
Metadata PostgreSQL Control Plane chỉ đọc, statement_timeout 2 giây/lock_timeout
500 ms: max_connections=100, superuser_reserved_connections=3, reserved_connections=0,
database connection limit=-1, **role Backend connection limit=15**. Mẫu hiện tại
có 3 client backends (gồm probe), không đại diện nhu cầu đỉnh. Không count bảng
lịch sử hoặc thử lại audit backlog. Tăng Hikari lên 32/64 cần giải quyết riêng
role limit và ngân sách các client cùng cluster; không suy max_connections=100
là ngân sách dành toàn bộ cho Backend. Hikari max/minIdle chỉnh tại env VPS,
launcher đọc lại env khi service Backend khởi động. Review index vẫn pending;
phần tư vấn này chưa cấp quyền thay DB role, runtime hoặc workload tiếp.

## Cập nhật mới nhất — 2026-10-01 05:30 UTC: xác nhận lỗi lấy connection DB

Điều tra theo yêu cầu người dùng chỉ tải log có giới hạn và phân tích offline;
không chạy tải mới, SQL, deploy hoặc thay service/runtime/config. Evidence đã
lược bỏ credentials/headers/URL riêng tư: `tmp/load/phase4-500-failure-diagnosis.json`.

**Đã xác nhận Backend cạn connection khả dụng trong pool.** Log đầu tiên lúc
03:57:51.830 UTC ghi `HikariPool-1`, total=10, active=10, idle=0, waiting=90,
request timed out after 5128 ms. Trong cửa sổ 03:57:30–04:08:59 UTC có 249
log dòng timeout lấy connection và 248 log `Unhandled request failure` với root
`CannotCreateTransactionException`. Đây là số dòng log, không phải 249 request
k6 hoặc cách phân loại toàn bộ 907 lỗi. Hibernate không mở được transaction;
handler trả HTTP 500/INTERNAL_ERROR. Các stack gồm login, dashboard, website,
scan list/progress và messaging. Crawler cũng ghi event delivery HTTP 500 lúc
03:58:01.906 và event acknowledgement `lease is stale` sau đó; không quy lỗi
lease cho nguyên nhân riêng khi chưa đo.

Đối chiếu **cùng correlation ID** `be88952c-70a0-4335-b6c2-22890fe44d62`:

- Caddy access: GET `/api/v1/scans/{scanId}`, HTTP 500, duration 7,096 giây,
  timestamp server 03:57:55.907 UTC; request không có k6 User-Agent.
- Scan ID thuộc 500 admission HTTP 202 gốc. Backend stack cùng ID đi qua
  `ScanService.get`, `CannotCreateTransactionException` và timeout acquire
  5450 ms (total=10, active=10, idle=0, waiting=71).
- Harness yêu cầu polling HTTP 200; non-200 làm `Require-Status` throw và
  outer finally gửi cancellation. Đây là bằng chứng mạnh cho đường lỗi
  polling làm dừng bài test, **chưa phục hồi được exception gốc của harness**.
  Manifest trên generator ghi FAILED 03:57:52.641, khác timestamp server;
  chưa có proof độ lệch clock lịch sử để khẳng định cùng mốc tuyệt đối.

Đọc riêng allowlist env hiện tại xác nhận worker=64/host=2, Hikari max=10/
minIdle=2, Tomcat maxThreads=100/minSpare=10. Metrics lưu trong chính lượt test
cũng ghi max pool 10 và max threads 100. **Tăng worker crawl lên 64 không tăng
pool Backend.** Không lấy default 64 trong source YAML làm cấu hình runtime.
Telemetry là thu thập tuần tự, timestamp không đồng nghĩa mọi metrics/PG được
đo cùng thời điểm. Một mẫu có 62 pending acquire; có idle-in-transaction/Client
wait, nhưng chưa có timing từng transaction/SQL để phân bổ nguyên nhân giữ pool.

610 `SCAN_PAGE_NOT_FOUND` xảy ra khoảng 03:58:14.872–03:59:11.662 theo clock
generator, trùng cleanup. Contract production có hai nhánh not-found: owner
scan không thấy ở Control Plane hoặc Crawler không thấy report execution.
Command dispatch chậm/chưa tạo execution là giả thuyết phù hợp backlog, chưa
có log từng request chứng minh; không coi 404 là lỗi pool hoặc tự bỏ failure.
Mixed stderr có 158 cảnh báo `request timeout` (cả login/read API); không đồng
nhất số warning này với toàn bộ error codes hoặc exception fatal của harness.

Code hiện tại có bcrypt bên trong transaction login và HTTP Crawler bên trong
transaction report; đây là các vị trí cần đo thời gian giữ connection, chưa
chứng minh mức đóng góp. Trước lượt tiếp cần sửa việc lưu primary exception
để recovery không ghi đè, rồi đo transaction/pool/SQL/remote call theo evidence.
Lượt điều tra này chỉ cập nhật bằng chứng, **chưa sửa harness hoặc production**;
không tự tăng pool/threads, deploy hay chạy lại tải. Global recovery vẫn unknown,
review index revision 1 vẫn pending, Phase 3–6 còn mở.

## Cập nhật mới nhất — 2026-10-01 04:40 UTC: lượt 500 thất bại, mọi scan đã terminal

Đã kiểm tra heartbeat và kết quả thật của `20261001T035026Z`. Wrapper PID 21812
đã thoát; không còn bài test đang chạy. **Không hoàn thành workload 500.000 trang**.
500 admission đều HTTP 202, nhưng harness ghi `FAILED` lúc **03:57:52 UTC** và
đi vào terminal cleanup, hủy scan qua command API. Đây là lỗi harness, không phải
auto-stop RAM/CPU hoặc bỏ user waiver. Exception gốc không còn trong artifacts:
manifest chỉ ghi `harness_exception_see_wrapper_state`, wrapper ghi đè detail khi
recovery thất bại. **Chưa xác định loại/nguyên nhân exception**, không tự gán cho
timeout, DB, report hoặc resource. Phải lưu diagnostic lỗi gốc trước lượt tiếp.

Mixed API chạy đủ cửa sổ khoảng **03:57:43–04:07:43 UTC** với 500 VU, trong lúc
scan bị hủy/cleanup; không phải API suốt một crawl 500 scan hoàn chỉnh. Có
**55.707 HTTP request**, **907 lỗi (1,6282%)**, p95 **7.189,67 ms**, p99
**8.125,22 ms**, bao gồm login. Không đạt SLO p95 300 ms/error dưới 1% hoặc
threshold harness p95 1.000 ms. Raw phân tách endpoint:

| Endpoint | Requests | HTTP lỗi | p95 ms |
| --- | ---: | ---: | ---: |
| Login | 666 | 166 | 9.877,16 |
| Dashboard | 11.152 | 60 | 7.227,32 |
| Danh sách website | 11.084 | 49 | 6.385,85 |
| Lịch sử scan | 10.984 | 13 | 5.999,30 |
| Tiến độ scan | 10.939 | 7 | 6.599,68 |
| Danh sách trang | 10.882 | 612 | 7.630,65 |

Ngoài login: 55.041 request/741 lỗi; error codes gồm 610 `SCAN_PAGE_NOT_FOUND`,
57 `INTERNAL_ERROR`, 74 `HTTP_0`. Giữ cả 404/error, không tự bỏ vì cancellation.
Không dùng khác biệt với baseline 150 để kết luận regression hoặc capacity.

Cleanup ban đầu lúc 04:08:41 chỉ xác minh 499 `CANCELLED`, còn một scan chưa
terminal. Đối chiếu đúng admission/account/website bằng credentials DPAPI lúc
**04:33:46** thấy scan còn lại đã `PARTIAL_SUCCESS` (1.000 processed/770 success/
230 failed); **không cần gửi cancellation mới**. Follow-up chỉ login/GET, không
replay scan POST/DDL/thay service/config. Nay **500/500 terminal**: 499 CANCELLED,
1 PARTIAL_SUCCESS. Tổng **10.721 processed**, **2.269 succeeded**, **8.452 failed**;
không phải 500.000 trang hoặc throughput của workload hoàn chỉnh.

Telemetry đã tải về sau wrapper lỗi: VPS 53 mẫu, RAM sample max **75,20%**, CPU
sample max **76,4%**; generator 140 mẫu, RAM max **65,09%**, CPU max **37%**.
Ba nguồn PostgreSQL đều available trong các mẫu VPS. Đây là max mẫu quan sát,
không chứng minh không có đỉnh giữa mẫu hoặc nguyên nhân exception. Không backup,
không bật lại guard, không tự chạy workload thứ hai hoặc restore worker 20.

Proof recovery mới **04:34:58**: active/backlog trong scope đã đo đều 0, hai
routes off, RAM 68,77%, nhưng worker curl timeout 5 giây nên
`observedWorkloadRecovered=false`; global vẫn false vì DEAD/orphan PERSISTING
chưa đo. Kiểm độc lập có giới hạn **04:37:49**, không SQL/service changes: curl cả
ba HTTP 200/body UP và IWR cả ba HTTP 200. Backend IWR body UP check ghi false,
không có raw body status để giải thích; không coi cả ba IWR body UP. Giữ nguyên
probe thất bại, không giải thích timeout cũ hoặc kết luận stability từ recheck.

Artifacts: run directory `tmp/load/phase8-worker64-500-no-guards-retry-500x1000-20261001T035026Z`:
`outcome-followup.json`, `cleanup-followup-state.json`, `500-scans/cleanup-scans-followup.json`,
`500-scans/mixed-summary.json`, `500-scans/mixed.jsonl`, `500-scans/vps.jsonl`.
Ngoài run: `tmp/load/phase4-500-recovery-followup.json`,
`tmp/load/phase4-500-health-followup-comparison.json`.
Analyzer offline đối chiếu endpoint totals/HTTP errors/API error codes và 500
scan IDs riêng biệt đạt. Review index vẫn pending; Phase 3–6/global recovery còn
mở. Không shutdown. Cấu hình automation đọc trong lượt này và kết quả tool update
đều là ACTIVE, khác mô tả PAUSED cũ; giữ trạng thái hiện có, không tự pause/resume.
Sau khi đối chiếu 500 admission/terminal identities và proof lượt đầu chỉ lỗi
setup/chưa admission, đã lưu `private-seed-cleanup-proof.json` rồi xóa private
seed/password DPAPI của cả hai lượt; raw/public evidence giữ nguyên. Record
`phase4-500-active-run.json` nay đánh dấu ended/failed, không còn báo đang chạy.

## Cập nhật mới nhất — 2026-10-01 03:59 UTC: 500 scan đã nhận, API đang chạy

Lượt `20261001T035026Z`, PID 21812, đã thực hiện **500 admission, 500 ACK HTTP
202, 500 scan ID riêng biệt, error rate admission 0%**. Burst diễn ra khoảng
03:57:38–03:57:40 UTC; p95 **1.750,27 ms**, không đạt threshold admission p95
1.000 ms nên k6 exit 99. Đây là latency tạo scan, không phải p95 mixed API. Giữ
nguyên failure và tiếp tục workload theo user waiver; không dừng vì threshold
hoặc resource guard.

Mixed activity **500 VU** bắt đầu **03:57:42 UTC**, dự kiến 10 phút như baseline;
đọc dashboard/website/history/progress/pages, nghỉ 3 giây sau request. Crawl
500 × 1.000 trang còn đang chạy; chưa có tổng trang cuối, throughput hoặc p95
mixed API. Không chứng nhận capacity 500 hoặc toàn bộ 500.000 trang từ ACK.
Không backup, không guard tài nguyên tự dừng theo yêu cầu trực tiếp. Giữ cleanup
identities/terminal/route; global recovery vẫn unknown, review index pending.

Evidence xác nhận bắt đầu: `tmp/load/phase4-500-started-evidence.json`;
raw `submission-observations.json`, `submission-summary.json`,
`mixed-state.json`, `mixed.jsonl` trong
`tmp/load/phase8-worker64-500-no-guards-retry-500x1000-20261001T035026Z/500-scans`.
Wrapper tiếp tục chạy nền và lưu kết quả/thu hồi/tắt route khi kết thúc. Không
tạo workload thứ hai hoặc thay service/config trong lúc này.

## Cập nhật mới nhất — 2026-10-01 03:50 UTC: sửa timeout chuẩn bị 500

Lượt `20261001T033711Z` đã tạo đủ 500 tài khoản/website nhưng k6 setup đăng nhập
tuần tự vượt 120 giây, hoàn thành 298 login request. Không có admission metric
point hoặc admission observation; đối chiếu history đúng owner cả 500 website
không thấy scan. API/crawl chưa chạy; các giá trị custom admission 0 trong
summary là không có mẫu, không phải latency 0 ms. Collector/route của lượt đầu
đã kết thúc/tắt; global recovery vẫn unknown, không gán true. Giữ nguyên lỗi gốc.
Evidence `tmp/load/phase4-500-setup-failure.json`.

Đã tăng riêng `setupTimeout` khi count 500 từ 2 lên 10 phút để hoàn thành việc
chuẩn bị login. Count 150 vẫn 2 phút; request timeout 5 giây, maxDuration admission
30 giây, thresholds/SLO không đổi. Đây không phải nới latency chấp nhận của
request đo tải. Nhánh 500 offline kiểm lại đạt.

Thêm `ExistingSeedDirectory` vào harness/wrapper để dùng lại đúng 500 accounts/
websites và password DPAPI, không đăng ký thêm. Kiểm scope directory tmp/load,
cardinality/uniqueness/index, đăng nhập từng owner và history phải rỗng trước
admission. Không replay scan POST: lượt đầu chưa có admission. Lượt sau có runId
và idempotency key mới, danh sách public riêng. Retention/terminal cleanup giữ
nguyên; password không log hoặc lưu plaintext.

Khởi động PID **21812** lúc **03:50:20 UTC**, label
`worker64-500-no-guards-retry`, seed từ lượt đầu. Vẫn ngoại lệ trực tiếp bỏ
backup/operational guard, 64 worker/host 2/binaries gốc, 500 × 1.000 trang kèm
500 VU API/10 phút. Chưa kết luận tải đã đủ hoặc capacity. Nguồn trạng thái:
`tmp/load/phase4-500-active-run.json`,
`tmp/load/phase8-scheduled-state-worker64-500-no-guards-retry.json`.

## Cập nhật mới nhất — 2026-10-01 03:37 UTC: chạy 500 theo ngoại lệ trực tiếp

Người dùng yêu cầu rõ: **"không cần backup hay guard, hãy chạy cho tôi"**.
Yêu cầu mới thay các điều kiện backup/readiness/recovery trước tải và guard
resource của riêng lượt này. Đã thêm `SkipOperationalGuards` vào wrapper/harness
hiện có và bắt đầu tiến trình PID 33996 lúc 03:37:05 UTC, label
`worker64-500-no-guards`: 500 tài khoản riêng biệt × 1.000 trang, 64 worker/host 2,
binaries gốc, 500 VU API trong 10 phút. Chưa coi khởi động harness là đã tạo đủ
500 scan hoặc hoàn thành workload; kết quả theo artifacts thực.

Không tạo backup cho lượt này. Bỏ pre-load global/resource/telemetry gates và
auto-stop theo RAM/CPU/health; vẫn thu telemetry, giữ timeout/SLO và ghi failures.
Giữ xác minh đúng binaries/concurrency/fixture, target authorization, owner,
quota, SSRF, idempotency, đối chiếu admission và terminal cleanup, tắt route khi
kết thúc. Nếu server đã tạo đủ 500 scan dù client timeout hoặc k6 threshold
thất bại, lượt này vẫn chạy API với đủ 500 identities đã đối chiếu; lỗi client
không đổi thành success. Không replay POST hoặc tự sửa DB để đủ count.

Kiểm thử offline 500 đạt cả nhánh mặc định chặn unknown và nhánh user waiver
thực sự chạy mock harness, truyền đúng option, tắt route và giữ recovery unknown.
Global DEAD/PERSISTING trước tải vẫn **chưa xác minh**, không chuyển null/false
thành 0/true. Review index revision 1 vẫn pending; ngoại lệ vận hành không duyệt
DDL/schema/grants. Automation vẫn PAUSED, không shutdown.

Record tiến trình: `tmp/load/phase4-500-active-run.json`; state:
`tmp/load/phase8-scheduled-state-worker64-500-no-guards.json`; stdout/stderr:
`tmp/load/phase8-worker64-500-no-guards-stdout.log` và `-stderr.log`.

## Cập nhật mới nhất — 2026-10-01 03:29 UTC: yêu cầu 500 người

Người dùng xác nhận **500 tài khoản riêng biệt, mỗi tài khoản tạo một scan
1.000 trang và dùng API**: tổng 500.000 trang. Worker hiện là 64, host limit 2,
Backend/Crawler gốc. Chưa phát tải 500 người hoặc tạo tài khoản/website/scan cho
lượt này. API dự kiến 500 VU, luân phiên dashboard/website/scan/progress/pages,
nghỉ 3 giây sau mỗi request, chạy 10 phút như cửa sổ baseline; không phải API
liên tục suốt crawl của Phase 6. Giữ nguyên request timeout và ngưỡng kết quả;
SLO đánh giá API vẫn p95 300 ms. Workload 500 không phải phép before/after cùng
workload 150.

Đã mở rộng harness/wrapper hiện có bằng `UserCount=150|500`, chọn hash Crawler
gốc hoặc report candidate rõ ràng; mặc định gốc, không deploy candidate. Analyzer
nhận `ScanCount=500`. Wrapper kiểm hai global proof mới, RAM dưới 85%, routes
off trước bật route; direct harness cũng từ chối global recovery unknown trước
seeding. `PreflightOnly` không upload helper hoặc đổi route/service. Không bỏ
failure, biến unknown thành 0 hoặc retry để vượt gate.

Kiểm thử offline trên PowerShell 7 đạt cho cả 150 và 500 identities, giữ nguyên
29 client timeout đã commit trong dữ liệu giả lập (121/471 ACK), đối chiếu đúng
owner/website, không replay admission POST và xác minh terminal cleanup. Kiểm
gate unknown/missing/string/routes/RAM/stale/future và wrapper thực với network
mock đều chặn trước route. Password recovery mã hóa Windows DPAPI cho user local;
chỉ xóa private seed/password sau khi mọi admission identity đã biết, scan đã
terminal và cleanup-state đã lưu. Kiểm round-trip/retention/deletion đạt.
Các kiểm tra này không phải workload production hoặc phép đo performance.

`node tmp/load/phase4-500-k6-offline-check.cjs` đạt: 150/500 tài khoản riêng biệt,
chặn seed thiếu/trùng, thiếu xác nhận tải và remote target chưa xác nhận trước
login; k6 inspect xác nhận 500 VU/one admission per VU. Không network thật hoặc
credentials thật. Parser các script PowerShell đạt. Giới hạn còn cần kiểm trước
lượt thực: admission hiện đợi k6 hoàn tất (setup tối đa 2 phút, admission tối đa
30 giây); vòng kiểm resource/health trong harness crawl bắt đầu sau admission
và duyệt scan tuần tự. Chưa chứng minh guard liên tục đủ nhanh cho burst 500;
phải giải quyết trước chạy, không coi chuẩn bị offline là readiness hoàn chỉnh.

Preflight read-only cụ thể cho lượt 500 lúc **03:29:17 UTC**:
ba health HTTP 200/body UP, sáu service Running, RAM **67,96%**, browsers 0,
hai routes off, binaries gốc; mọi backlog trong scope đã đo 0.
`observedWorkloadRecovered=true`, **`globalRecoveryVerified=false`** vì event
outbox DEAD và PERSISTING ngoài active executions chưa đo. Wrapper dừng tại
**PREFLIGHT_BLOCKED**, không bật route, seeding hoặc chạy k6. Timeout của probe
03:18 vẫn giữ trong `tmp/load/phase4-500-readiness.json`; mẫu đạt mới không giải
thích timeout cũ hoặc chứng minh stability dài hạn. Không lấy thời gian health
request làm p95 API dưới tải.

Artifacts: `tmp/load/phase8-scheduled-state-worker64-500.json`,
`tmp/load/phase8-worker64-500-preflight-1.json`,
`tmp/load/phase4-500-preparation.json`. Review index revision 1 đã hỏi và vẫn chờ;
không hỏi lại, không thực thi DDL/count lịch sử/audit đã thất bại. Trước workload
thật còn cần recovery global, guard admission/crawl, telemetry hai nguồn, backup
mới có đối chiếu hash/offhost và kế hoạch cleanup/rollback. Phases 3–6 còn mở,
chưa có throughput/p95/capacity 500 người. Automation giữ PAUSED, máy giữ bật.

## Cập nhật mới nhất — 2026-10-01 02:59 UTC

Theo yêu cầu trực tiếp mới của người dùng, đã tăng giới hạn worker Crawler
production từ **20 lên 64** và khởi động lại riêng Crawler. Yêu cầu này thay
lộ trình thử 20 → 40 → 64; đây là đổi cấu hình, **chưa phải benchmark Phase 4
đạt**. Host concurrency vẫn 2, binaries Backend/Crawler gốc và các pool không
đổi. Không chạy workload, bật route synthetic hoặc triển khai patch code.

Hai mẫu preflight đầy đủ lúc 02:58:52/02:59:10 đều ba health UP, sáu service
Running, RAM 68,47%/68,48%, không workload/backlog trong phạm vi đã đo. Đã sao
lưu nguyên bytes cấu hình và ACL trên VPS, kiểm hash trước sửa; chỉ đổi
`CRAWLER_WORKER_CONCURRENCY=20` thành `64`. Không đưa backup chứa secrets ra
workspace hoặc log. Tiến trình Crawler cũ PID 11212 đã thoát; PID mới 1220 có
thời điểm tạo sau thay đổi, đọc launcher/env hiện hành. Không cưỡng bức kill.

Hai mẫu sau đổi lúc 02:59:20/02:59:39 đều ba health HTTP 200/body UP, sáu service
Running, browsers 0, hai route off; RAM 69,47%/69,31%. Control active/outbox,
Crawler active/queued/leased/active persisting/host leases/analytics/event
PENDING+CLAIMED và Capture jobs/outboxes đều 0. `observedWorkloadRecovered=true`,
nhưng **globalRecoveryVerified=false**: event DEAD và orphan PERSISTING vẫn
chưa đo; review index revision 1 vẫn đang chờ. Không dùng thao tác này để
chứng nhận recovery toàn cục, SLO, capacity 500 người hoặc throughput tăng.

Probe ban đầu 02:54 có hai worker curl timeout 5 giây, dù services Running;
kiểm tra độc lập 02:54:58 curl/IWR cả ba HTTP 200, rồi probe đầy đủ 02:56:36
và hai preflight sau đó đạt. Lỗi ban đầu được giữ trong nhật ký, chưa xác định
nguyên nhân; không nới timeout hoặc sửa verifier để bỏ lỗi.

Provenance:

- Artifact public: `tmp/load/phase4-worker64-change.json` (`APPLIED_HEALTHY`),
  `phase4-worker64-config-before.json`, `phase4-worker64-readiness-before.json`,
  `phase4-worker64-recovery-before.json` trong cùng thư mục.
- Proof VPS: `C:\ProgramData\WebLens\performance-fixture\runtime\worker64-change-20261001T025849Z.json`.
- Backup VPS: `C:\ProgramData\WebLens\worker-config-backup-20261001T025849Z\weblens.env.original`.
- Env SHA256 trước: `47f236f77046a4e5c092b9335fcc9e661edd4b938205ffd48a58b3c5d54484c2`;
  sau: `d49d55d0819d949d642761ea1e4052bb19665466f013f8a2027d18c6730bf2f7`.
- Helper một lần `tmp/load/phase4-set-workers-64.ps1`: mutex deploy, backup/hash,
  hai preflight và hai postflight cách 15 giây, rollback nếu kiểm tra thất bại;
  parser và kiểm thay đúng một dòng đạt. Backend/Crawler hashes vẫn gốc.
- Readback 03:03:37 trong `tmp/load/phase4-worker64-config-after.json` xác nhận
  env worker 64/host 2/hash sau đổi. Launcher VPS và local khác hash bytes do
  line endings; sau chuẩn hóa CRLF/BOM có cùng SHA256
  `4f4b169428f74163668b166386b16c8cd14baf4d331b13a1bc340be7a0c7698a`,
  xác nhận launcher đọc env lúc khởi động và không override worker.

Phase 3–6 chưa hoàn tất; không chạy tải mới khi recovery/harness gate chưa đạt.
Automation hiện đã PAUSED trước thao tác này; giữ trạng thái đó. Không tắt máy.

Người dùng đã cho phép thực hiện toàn bộ sáu phase ngày 2026-09-30. Tiếp tục các
phase theo bằng chứng, báo cáo tiến độ và kết quả; không cần dừng để xin review
sau từng phase. Các ngưỡng bảo vệ production và chính sách thiết kế DB vẫn áp dụng.

## Điều kiện tắt máy theo yêu cầu mới

Chỉ tắt máy Windows local sau khi toàn bộ công việc WebLens thực sự hoàn tất,
báo cáo đã lưu, production khỏe, hai route synthetic tắt và active scan/backlog
bằng 0. Trước đó phải kiểm tra các task ChatGPT/Codex quan sát được trong ứng
dụng, gồm cả task ghim và danh sách thường. Nếu còn task khác chạy hoặc process
test/build/deploy/collector chưa kết thúc thì tiếp tục chờ; không tự hủy task đó.
Lượt kiểm tra tắt máy không tính là công việc khác, nhưng công việc WebLens phải
đã kết thúc thật. Xác minh lại ngay trước shutdown, rồi tạm dừng automation.

Không coi nguồn/host không truy cập được là idle. Công cụ ứng dụng không tự
chứng minh tác vụ ChatGPT trên trình duyệt hoặc thiết bị khác đã kết thúc;
nếu cần bao quát nguồn không quan sát được thì giữ máy bật và làm rõ phạm vi.
Không tắt cưỡng bức để bỏ qua task đang chạy hoặc ứng dụng chưa lưu.

## Mốc so sánh

- Baseline: `tmp/load/phase8-150x1000-20260930T083903Z`.
- 150 tài khoản × 1.000 trang, 150 VU đọc năm endpoint trong 10 phút đầu.
- 150/150 scan hoàn tất; 150.000 trang thành công; 15,8934 trang/giây.
- Chờ bắt đầu median 4.197,8 giây, p95 8.390,4 giây; nhận kết quả median
  4.917,0 giây, p95 8.980,3 giây. Các giá trị percentile nội suy tuyến tính.
- API tổng p95 674,83 ms; danh sách trang p95 936,04 ms. Error rate 0,00355%.
- Production: Windows Server 2019, 8 logical CPU, khoảng 7 GiB RAM,
  PostgreSQL 17.11, Java 21, JVM heap tối đa 1.280 MiB theo launcher;
  Hikari 10, crawler PostgreSQL pool 20, Tomcat 100 thread;
  crawler 20 worker, host 2 slot, scan 1.000 trang/concurrency 20.
- Không lấy mức 10.000 worker mặc định trong workspace làm cấu hình production.

## Trạng thái thực hiện

| Phase | Trạng thái | Bằng chứng và việc tiếp theo |
| --- | --- | --- |
| 1. Cấu hình/phép đo | Hoàn tất phần kiểm kê và chuẩn hóa | Xác minh production commit `9e87e8b0c95ea1791dcc4814793e45b1e391ca36`; analyzer xuất p50/p95/p99 theo endpoint và thời gian chờ. Harness xác minh hash backend, worker và host limit trước tải. Tách pending kết nối tạm thời khỏi timeout hoặc hủy tải. |
| 2. Transaction API | Đã thử; workload dừng theo RAM guard và patch đã rollback | Commit riêng `be63961`: `ScanReportService` dùng `NOT_SUPPORTED`, truy vấn phân quyền kết thúc trước cuộc gọi crawler. 68 unit/security tests đạt. Lượt 150 scan sau patch dừng khi RAM vượt 90% hai mẫu liên tiếp; 127/150 scan hoàn tất, 23 bị hủy. Độ trễ API giảm ở mẫu đo nhưng chưa đạt SLO 300 ms và crawl không hoàn chỉnh, nên chưa xác nhận cải thiện end-to-end. Backend production đã khôi phục SHA-256 bản gốc. |
| 3. Báo cáo trang | Microbenchmark/validation đạt; tải dừng ở admission, Crawler đã rollback | Commit `c27edfb` có tín hiệu giảm warm median 24,95%/29,82%, chưa phải p95 API. Retry có 29 client timeout dù DB tạo đủ 150 scan, chưa chạy mixed API; đã hủy đủ 150 và khôi phục Crawler gốc. Harness đối chiếu timeout đã sửa/test offline; recovery global chưa đạt. Bản đo admission `044fa4f` build/test local đạt, chưa deploy; cần đo pool/lock trước xác nhận report dưới tải. |
| 4. Worker | Đã cấu hình 64 theo yêu cầu mới; chưa benchmark | 2026-10-01 02:59 UTC đổi 20 → 64, restart riêng Crawler và hai postflight đạt. Giữ host 2/pools/binaries; chưa có throughput, API p95 hoặc capacity ở 64 worker. Recovery global vẫn thiếu hai scope, chưa chạy tải mới. |
| 5. Phân phối scan | Chờ bằng chứng Phase 4 | Đo thời gian chờ và nhận kết quả. Thay lịch phân phối nếu scan mới bị chờ dài; bảo toàn lease, fencing, giới hạn host và hủy scan. Khởi động sớm không được diễn giải thành hoàn tất sớm. |
| 6. Xác nhận | Chưa chạy | Lặp cấu hình tốt nhất, tính % cải thiện cùng workload; chạy riêng API liên tục trong thời gian crawl. Xác minh dữ liệu, retry, recovery; chốt cấu hình đã đo. |

## Bản sửa production và khả năng khôi phục

Checkout riêng: `C:\Users\HP\.codex\worktrees\performance-metrics\Pet_project`,
branch `codex/performance-queue-api`, dựa trên đúng release baseline. Không nhập
thay đổi đang có ở workspace chính vào bản sửa backend.

Backend SHA-256 sau sửa:
`116e6da21037c8a9e898dba9b81171406842ff5887990475d14db955e965532b`.
Backend SHA-256 gốc:
`5bff335f8975fc8830a3328895fb4ebe79eb92b53473b85d9304c06fd3e3035f`.

Đây là bản sửa có manifest riêng; metadata release nền vẫn là commit baseline.
Manifest cùng bản jar gốc nằm trên VPS tại
`C:\ProgramData\WebLens\performance-fixture\runtime\api-transaction-patch`.
`tools/load/manage-performance-patch-windows.ps1` kiểm hash, sao lưu jar,
khởi động backend và tự khôi phục nếu health không đạt. Action `restore` phục
hồi jar gốc; không xóa bản sao hoặc dữ liệu DB.

Backup ba PostgreSQL mới đã tải ra ngoài VPS và kiểm dung lượng/SHA-256 tại
`tmp/load/offhost-backups/performance-preflight-20260930T121848Z`. Backup này
không chứa ClickHouse hoặc R2. Trước triển khai: active scan 0, analytics
backlog 0, bốn health HTTP 200. Có một preflight tạm thời báo Crawler 503 và
Capture timeout; các lần kiểm tra sau đều hồi phục, chưa xác định nguyên nhân.

## Theo dõi lượt hiện tại

- Wrapper: `tmp/load/phase8-scheduled-run-150.ps1 -RunLabel api-after-20 -WorkerConcurrency 20`.
- State: `tmp/load/phase8-scheduled-state-api-after-20.json`.
- Lượt đã dừng: `20260930T122538Z`; artifact:
  `tmp/load/phase8-api-after-20-150x1000-20260930T122538Z`.
- Route synthetic được bật/tắt trong wrapper; bài chỉ crawl hostname do mình kiểm soát.
- Guard dừng khi CPU/RAM ≥90% hoặc health lỗi hai mẫu liên tiếp; timeout DB,
  trang thiếu, scan không hoàn tất và recovery không đạt đều phải báo cáo.
- Một mẫu Hikari pending đơn lẻ được ghi nhận; SLO API p95 300 ms và error rate
  dưới 1% vẫn dùng để đánh giá. Threshold k6 1 giây là ngưỡng của harness gốc.

## Kết quả thử patch transaction — 150 scan × 1.000 trang

Run `20260930T122538Z`, cùng workload baseline, crawler vẫn giữ 20 worker và
giới hạn hai slot mỗi host. Artifact:
`tmp/load/phase8-api-after-20-150x1000-20260930T122538Z`.

- Đã nhận 150/150 scan. Guard dừng tải sau hai mẫu RAM liên tiếp ở
  **90,18% và 90,19%**; CPU cùng thời điểm khoảng 63%, ba health endpoint vẫn
  trả 200. 127 scan hoàn tất, 23 bị hủy. Scan hoàn tất có 127.000 trang;
  bộ đếm gồm tiến độ từ scan bị hủy ghi nhận 130.475 trang thành công và
  3.697 trang lỗi. Đây không phải workload 150.000 trang hoàn thành.
- API trong 10 phút: 28.591 request, 47,36 request/giây; p95 tổng
  **588,73 ms**, p99 **785,49 ms**, 15 lỗi HTTP 404 ở `scan_pages`
  (0,0525% tổng request). Baseline p95 tổng 674,83 ms và p99 1.890,93 ms;
  chênh lệch tương ứng -12,76% và -58,45%. Cửa sổ API chỉ kéo dài 10 phút,
  còn crawl tổng bị dừng; chưa coi đây là kết quả xác nhận end-to-end.
- Theo endpoint, p95 baseline → patch: `auth_login` 1.876 → 1.149 ms;
  `dashboard_summary` 229 → 103 ms; `scan_list` 256 → 103 ms;
  `scan_pages` 936 → 770 ms; `scan_progress` 261 → 82 ms;
  `website_list` 266 → 102 ms. `scan_pages` p95 giảm khoảng 17,8%, nhưng 15
  phản hồi lỗi đều là 404 và tập trung trong khoảng 2 giây, khoảng 15 giây sau
  admission. Crawler trả 404 khi chưa có execution row cho report; vì vậy một
  race report-before-accept là khả năng hợp lý nhưng chưa xác nhận từng request.
- Rà soát mã nguồn đã khoanh rõ một nhánh 404: `ScanReportService.listPages`
  kiểm tra scan/owner trong Control Plane rồi gọi Crawler; `Store.GetReportState`
  trả `ErrReportNotFound` nếu chưa có `crawl_executions`, và handler ánh xạ lỗi
  đó thành 404 trước khi chạy truy vấn ClickHouse. Tuy nhiên K6 chỉ lưu HTTP
  status, không lưu mã lỗi/body hay scan ID, nên chưa thể gán 15 phản hồi cho
  nhánh này thay vì nhánh scan/owner không tồn tại. 15 mốc nằm trong khoảng
  12:30:42.261–12:30:44.585 UTC. Đã thêm metric K6 `weblens_api_errors`, gắn
  tên endpoint và mã lỗi đã lọc; `k6 inspect` đạt. Thay đổi chỉ ở harness local,
  chưa phát request tới production.
- Queue wait trên 136 scan đã bắt đầu: median 3.884 giây / p95 8.275 giây,
  so với baseline 4.198 / 8.390 giây trên 150 scan. Không so chênh lệch này như
  cải thiện workload vì lượt patch bị hủy.
- Sau tải: Control Plane, Crawler, Capture đều `UP`; không còn page queued,
  leased hoặc persisting, host lease hay analytics chưa publish; Hikari pending
  bằng 0. Route synthetic đã tắt, service fixture còn chạy nội bộ.
- Wrapper kết thúc `FAILED_RESTORED` do lỗi tổng hợp `Cannot convert null to
  type System.DateTime` khi tính queue wait cho scan bị hủy trước khi bắt đầu.
  Harness đã được sửa để chỉ tính queue wait cho scan có `startedAt`; analyzer
  cũng loại các scan đó khỏi percentile wait. Parser PowerShell và analyzer đã
  chạy đạt trên artifact patch cùng baseline.
- Kiểm kê sau tải thấy tiến trình MoreLogin/Chrome ngoài WebLens trên VPS;
  chưa đo được chính xác lượng RAM chúng chiếm tại thời điểm guard, nên đây là
  yếu tố nhiễu có thể có, không phải nguyên nhân đã chứng minh.
- Patch được rollback bằng script có kiểm tra manifest/checksum. SHA-256
  backend production hiện là bản gốc
  `5bff335f8975fc8830a3328895fb4ebe79eb92b53473b85d9304c06fd3e3035f`;
  health cả ba service đạt sau rollback.

Kết luận: patch có tín hiệu giảm độ trễ API trong cửa sổ 10 phút, đặc biệt ở
các endpoint đọc danh sách. Chưa chấp nhận patch làm cấu hình production tốt
nhất vì crawl chưa hoàn tất, p95 tổng còn cao hơn SLO 300 ms, `scan_pages` có
404 và RAM chạm guard. Không tăng worker khi VPS chưa có headroom ổn định.
Phase 3 tiếp tục bằng đo từng thành phần report và phân loại 404; phase 4–6
còn chờ môi trường đủ an toàn và bằng chứng đo được.

### Kiểm tra production chỉ đọc sau cảnh báo readiness — 2026-09-30

- Lúc 15:48:20 UTC: Control Plane, Crawler và Capture đều trả HTTP 200; các
  Windows services Backend, Crawler, Capture, PostgreSQL và Caddy ở trạng thái
  Running. RAM dùng 71,33%. Route synthetic báo `enabled=false`, fixture chỉ
  khỏe trên loopback, kiểm tra cách ly công khai đạt. Backend SHA-256 là bản
  gốc `5bff335f8975fc8830a3328895fb4ebe79eb92b53473b85d9304c06fd3e3035f`.
- Lúc 15:49:55 UTC: Crawler và Capture tiếp tục HTTP 200; RAM dùng 70,91%.
  Một lần đọc Control Plane không nhận được mã HTTP trong timeout của phép
  kiểm tra. Lúc 15:50:30 UTC, kiểm tra độc lập trả `{"status":"UP"}` với
  HTTP 200 trong 21 ms; service Backend vẫn Running và hash vẫn là bản gốc.
- Đây là kiểm tra sức khỏe ngắn, không đo active scans, DB backlog, Hikari hay
  độ trễ dưới tải. Chưa xác định nguyên nhân readiness DOWN/timeout thoáng qua;
  chưa chạy benchmark, thay cấu hình hoặc triển khai instrumentation. Tiếp tục
  chỉ quan sát read-only; chưa đủ bằng chứng để mở lượt tải production.
- Collector chỉ đọc lúc 16:03:16 UTC xác nhận Control Plane có 0 active scan,
  outbox `DELIVERED` 844, Hikari active/idle/pending là 0/2/0, timeout 0 và
  không có lock chờ; Capture PostgreSQL cũng đọc được. RAM còn 1,68 GiB/7 GiB
  (CPU 33,8%), bộ đếm có 14 tiến trình Chrome. Crawler PostgreSQL kết nối được
  nhưng truy vấn trạng thái workload thất bại; cả hai probe ClickHouse báo
  `unavailable`. Vì vậy chưa thể xác nhận page/analytics backlog của Crawler
  bằng mẫu hiện tại và chưa được phép bắt đầu benchmark. Snapshot gốc trên VPS:
  `C:\ProgramData\WebLens\performance-fixture\runtime\phase3-readonly-20260930T160315Z.jsonl`.

### Phase 3 — Đối chiếu collector và đo report chỉ đọc, 16:25–16:34 UTC

- Collector trên VPS khác bản local: hash VPS
  `c88e63b3c001d7c40b1314128e5e433eb7c44c551692f2f72b60f0d552ecf8da`,
  local `6844f929b39f6cb21db93e0e6b99c7fb1bef06c1517681c5d7081dc327f5997e`.
  SQL bản VPS còn nhiều phép đếm/tổng trên toàn bộ `scan_pages` và outbox;
  bản local đã dùng counters của các execution đang hoạt động. Một phép đếm
  lịch sử gộp ba bảng bị PostgreSQL hủy theo `statement_timeout=2000`; không
  đủ bằng chứng quy timeout cho một bảng cụ thể hoặc kết luận Crawler quá tải.
  `pg_stat_user_tables` ước tính analytics outbox có 478.846 bản ghi, execution
  có 696 bản ghi; đây là thống kê ước tính, không phải đối chiếu dữ liệu.
- Catalog xác nhận các partial index active execution, host lease và analytics
  backlog tồn tại. `EXPLAIN` không chạy query cho thấy analytics backlog dùng
  `Index Only Scan` trên `ix_analytics_outbox_backpressure`. Lúc 16:30:18 UTC,
  truy vấn chỉ lọc trạng thái đang hoạt động, giữ timeout 2 giây và transaction
  read-only, hoàn tất trong 247 ms gồm khởi chạy psql và truyền kết quả: active
  execution 0, queued/leased/persisting/unpublished 0, host lease 0, không có
  analytics outbox `PENDING`, `CLAIMED` hoặc `DEAD`. Không thay collector VPS,
  schema hoặc cấu hình ứng dụng.
- Lúc 16:25 có hai phép đọc readiness không thành công ở Crawler/Capture;
  chưa lưu được HTTP status cụ thể của hai phép đó. Kiểm tra độc lập bằng curl
  lúc 16:31 trả 200 cho Control/Crawler/Capture trong khoảng 43/371/206 ms;
  RAM dùng 71,88%, backend hash đúng bản gốc, route synthetic tắt và cách ly đạt.
  ClickHouse `SELECT 1` lúc 16:32 trả HTTP 200 cho cả hai role, tổng roundtrip
  604/352 ms. Kết nối được không chứng minh các query report đạt SLO.
- Ba lần đọc liên tiếp report của một scan fixture đã hoàn tất, `limit=20`,
  lúc 16:34 đều HTTP 200, trả 20 trang; expected/published đều 1.000. Tổng thời
  gian từ PowerShell client gọi Crawler đến đọc/parse kết quả là 1.298/915/624 ms.
  Đây là probe nhỏ trên scan đã hoàn tất, không có tải crawl; không suy ra p95,
  capacity hoặc phần trăm cải thiện so với workload baseline. Chưa tách được
  thời gian từng stage hay query ClickHouse.
- Rà soát thêm thấy Control Plane ánh xạ cả scan/owner không tồn tại và 404 từ
  Crawler thành cùng mã `SCAN_PAGE_NOT_FOUND`. Metric K6 `error_code` hữu ích để
  phân loại nhưng chưa đủ phân biệt hai nguồn. Instrumentation local Crawler
  đã bổ sung `scanId` vào slow-report log và log nhánh report-state không tồn
  tại; `go test ./internal/httpapi` đạt. Chưa triển khai instrumentation này.
- Artifact local: `tmp/load/phase3-catalog-20260930T162506Z.json`,
  `tmp/load/phase3-backlog-20260930T163018Z.json`,
  `tmp/load/phase3-health-20260930T163114Z.json`,
  `tmp/load/phase3-clickhouse-20260930T163252Z.json`,
  `tmp/load/phase3-report-probe-20260930T163444Z.json`.

Việc tiếp theo: chuẩn bị phép đo stage report có provenance và kiểm tra hồi
phục qua nhiều mẫu; đồng bộ collector test trong lần chuẩn bị benchmark được
phép tiếp theo, giữ giới hạn query và ghi `N/A` cho metric không thu được.
Không tăng worker hoặc chạy lại tải lớn chỉ dựa trên một probe health/queue tốt.
Phase 3 chưa có tối ưu report được triển khai; phase 4–6 vẫn chưa hoàn tất.

### Phase 3 — Tách SQL và roundtrip báo cáo, 16:49–17:03 UTC

Đây là chẩn đoán nhỏ, không phải benchmark tải. Không triển khai code, đổi
cấu hình dịch vụ hoặc tăng worker. Fixture đã được kiểm tra bằng lookup
PostgreSQL theo scan ID: `COMPLETED`, expected/published 1.000,
hostname `phase5-001.jobnext.top`; lookup mất 179 ms gồm psql overhead.

- ClickHouse `system.query_log` trả HTTP 500/code 497 (thiếu quyền). Không
  đổi grant hoặc flush log. Vì vậy chưa lấy được timing native của ba request
  report trước đó.
- Probe dùng SQL từ `crawler/internal/analytics/reports.go`, thay tham số bằng
  owner/scan fixture; lấy 21 trang để kiểm tra `hasMore`, findings cho 20 trang,
  rồi summary. Hai lượt tuần tự đều thành công qua HTTPS. Giới hạn mỗi query:
  server 2 giây, client 5 giây, 100.000 dòng đọc, 5.000 dòng kết quả và 256 MiB
  bộ nhớ. Đây là giới hạn của probe, không phải thay đổi cấu hình production.

| Stage | SQL server, lượt 1 / 2 | HTTPS roundtrip, lượt 1 / 2 | Dòng đọc | Byte đọc |
| --- | --- | --- | --- | --- |
| Danh sách trang | 52,44 / 24,53 ms | 433 / 398 ms | 24.628 | 9.467.473 |
| Findings | 22,25 / 24,99 ms | 600 / 370 ms | 32.934 | 5.598.948 |
| Summary | 24,85 / 24,61 ms | 372 / 374 ms | 57.562 | 4.022.296 |
| Tổng ba query | 99,54 / 74,12 ms | 1.405 / 1.142 ms | 115.124 | 19.088.717 |

Thời gian SQL lấy từ `statistics.elapsed` trong kết quả ClickHouse; roundtrip
bao gồm kết nối HTTPS mới cho từng query, TLS, truyền và đọc body. Production
dùng native `clickhouse-go`, pool kết nối tái sử dụng, LZ4; không gán trực tiếp
chênh lệch HTTPS này cho từng stage production. Số dòng đọc gồm dữ liệu được
đọc cho query/view/JOIN, không phải số trang khác nhau trong scan.

- Probe ban đầu với trần 128 MiB thất bại code 241. Body xác nhận cần cấp phát
  đến 129,24 MiB, vượt maximum 128 MiB khi `MergeTreeSelect` đọc bảng
  `page_metrics` trên S3. Khi probe nâng riêng trần lên 256 MiB, cùng SQL thành
  công. Không đo peak memory chính xác của query thành công; không suy ra RAM
  VPS hoặc bộ nhớ cho 150 request bằng cách nhân số này. Mã nguồn view dùng
  `FINAL` để giữ phiên bản hiện hành; không được bỏ dedup/tombstone nhằm tăng tốc.
- Bằng chứng hiện tại khoanh hai hướng: chi phí roundtrip của ba query tuần tự
  và lượng dữ liệu/bộ nhớ đọc cho report. Chưa chứng minh hướng nào là nút thắt
  đầu tiên khi có crawl/API đồng thời. Bước tiếp theo cần timing bằng native
  transport hoặc instrumentation stage đã chuẩn bị; chưa áp dụng cache, bỏ
  summary, song song hóa hay thay schema từ hai mẫu HTTPS này.
- Hai mẫu readiness đúng endpoint lúc 17:00:57 và 17:03:02 UTC đều HTTP 200
  cho ba service; RAM 72,25% và 71,84%. Hikari mẫu sau active/pending/idle 0/0/2.
  Backlog probe partial-index lúc 17:01:39 mất 169 ms: active execution, queued,
  leased, persisting, unpublished và host lease đều 0; không có analytics
  `PENDING`/`CLAIMED`/`DEAD`. Route synthetic vẫn tắt, backend hash đúng bản gốc.
  Hai mẫu đáp ứng điều kiện RAM/readiness để chuẩn bị lượt đo kế tiếp, nhưng
  collector VPS còn cũ và instrumentation chưa được triển khai: chưa chạy tải.
- Một probe lúc 17:00 dùng sai `/health` ở Crawler/Capture, nhận 404/401. Đó là
  lỗi endpoint của phép đo, không phải service DOWN. Đã kiểm tra lại bằng
  `/health/ready`; không đưa mẫu sai vào kết luận readiness.

Artifact tại `tmp/load`: `phase3-query-log-20260930T1643.json`,
`phase3-fixture-lookup-20260930T1650.json`, `phase3-stage-sql-20260930T1652.json`,
`phase3-page-memory-detail-20260930T1656.json`,
`phase3-stage-sql-256m-20260930T1657.json`,
`phase3-health-ready-20260930T1702.json`, `phase3-backlog-20260930T1703.json`,
`phase3-health-ready-20260930T1705.json`. Tên file dùng nhãn thời gian chuẩn bị;
timestamp UTC thực của từng mẫu nằm trong JSON. Chưa có before/after mới và
chưa hoàn tất Phase 3–6; chưa tắt máy.

### Phase 3 — Native transport và bản sửa local, 17:12–17:23 UTC

Đã chạy diagnostic riêng, chỉ đọc fixture đã hoàn tất. Dùng chính
`analytics.Open`, `ListPages`, `ScanSummary` và `clickhouse-go v2.43.0`, TLS,
LZ4, pool 10/5 như Crawler. Binary diagnostic nằm trong thư mục runtime test,
không thay executable dịch vụ, mở HTTP listener, khởi động worker hoặc migrate.
Mỗi query giữ readonly, timeout server 2 giây/client 5 giây, tối đa 100.000 dòng
đọc/5.000 dòng kết quả và 256 MiB bộ nhớ; toàn diagnostic có deadline 40 giây.
Credentials chỉ đọc trên VPS vào môi trường của process, không ghi vào artifact.

| Lượt | ListPages gồm page + findings | Summary | Tổng phần đọc analytics |
| --- | --- | --- | --- |
| 1 | 577,419 ms | 328,787 ms | 906,206 ms |
| 2 | 437,412 ms | 212,703 ms | 650,115 ms |
| 3 | 407,417 ms | 228,231 ms | 635,648 ms |

Cả ba lượt trả 20 trang, có trang kế tiếp và summary tổng 1.000 URL. Mở kết
nối/ping đầu mất 418,377 ms, nằm ngoài tổng bảng. Một diagnostic riêng chỉ ping
trên kết nối tái sử dụng đo 238,259 / 237,975 / 236,525 ms; mở/ping đầu lượt đó
mất 574,195 ms. Chi phí trao đổi VPS–ClickHouse đã lớn ngay cả khi không đọc
dataset. Đây là bằng chứng chọn giảm chờ giữa các query report; chưa xác định
địa lý, tuyến mạng, hàng đợi server hay capacity từ ba ping. Các số này không
bao gồm Control Plane, PostgreSQL report-state, HTTP response hoặc tải crawl;
không gọi là p95 API và không so % cải thiện workload 150 người.

#### Bản sửa đã chuẩn bị, chưa triển khai

Checkout riêng `C:\Users\HP\.codex\worktrees\performance-metrics\Pet_project`,
commit `c27edfbc1557df96562099d6cc798bcc46eed427`:

- Chạy `ListPages` và `ScanSummary` song song sau kiểm tra owner/report-state,
  cursor và filters. Giữ nguyên SQL, summary scan-wide, `FINAL`, pagination và
  giới hạn pool. Hai nhánh dùng context chung; lỗi ở một nhánh hủy nhánh còn
  lại và handler chờ cả hai kết thúc trước trả response.
- Giữ instrumentation stage/scan ID và log report-state 404 đã chuẩn bị. Các
  duration page/summary có thể chồng nhau, không cộng chúng để tính latency.
- Chỉ dùng `context`/`sync` chuẩn, không thêm dependency hoặc cache. Mỗi request
  có thể dùng hai kết nối analytics đồng thời: có nguy cơ tăng chờ pool hoặc
  áp lực ClickHouse dưới tải; phải đo trước khi chấp nhận production.
- Kiểm thử dùng barrier channel để chứng minh hai nhánh chồng nhau; kiểm tra
  lỗi của từng nhánh hủy nhánh còn lại, giữ cursor/tổng 1.000 khi chỉ trả một
  item, và không query analytics khi token/query/report-state không hợp lệ.
  `go test ./...` đạt; sau bổ sung test missing report, `go test ./internal/httpapi`
  đạt. Build Windows đạt, scoped diff check đạt, checkout sạch sau commit.
  `go test -race` chưa chạy được vì toolchain local đang CGO=0 và không có
  GCC/Clang trong PATH; không ghi kết quả race là đạt.
- Binary ứng viên local `tmp/load/phase3-crawler-parallel-c27edfb.exe`, SHA-256
  `89cb8dead8ee0fecf53e0beccab2de00f96f39cd0bde81b5e83b3ff3485e2c66`.
  **Chưa benchmark bản sửa và chưa deploy.** Branch còn chứa commit backend
  `be63961` của thử nghiệm trước: lần chuẩn bị triển khai tiếp chỉ được dùng
  binary Crawler này, giữ backend rollback gốc, không triển khai lại backend
  `NOT_SUPPORTED` cùng branch.

Kế hoạch tiếp: kiểm tra bản sửa qua diagnostic native đọc cùng fixture/workload
nhỏ; nếu kết quả đúng và tốt hơn thì chuẩn bị backup/hash/rollback Crawler cùng
collector đã đồng bộ trước validation production. Chỉ chạy lượt lớn cùng workload
150 × 1.000 + API 10 phút khi readiness/telemetry/headroom đạt guard. Nếu pool
wait, latency, error hoặc tài nguyên xấu hơn thì rollback; chưa tăng worker.

Recovery lúc 17:23:34 UTC: ba endpoint HTTP 200, RAM 71,48%, route synthetic tắt,
không còn process diagnostic. Hash backend vẫn bản gốc; hash Crawler production
trước/sau đều `2684ca92f4ce958c1261f8f7d93e3da74d810e1997fb7de61b526b2780531de4`.
Probe không tạo scan/page hoặc ghi analytics. Artifact: native preflight,
report JSONL, ping JSONL, recovery và provenance có tiền tố `phase3-native-`
trong `tmp/load`; provenance lưu checksum binaries/source/dependencies. Diagnostic
được build từ checkout local dirty; read path/connection/dependencies đã đối chiếu
base production, thay đổi write path khác không được gọi. Đây không phải release
binary của Crawler production. Phase 3 còn chờ benchmark ứng viên; 4–6 chưa chạy.

### Phase 3 — So sánh handler thực và chuẩn bị triển khai

Phép đo ABBA (baseline → candidate → candidate → baseline) dùng `httpapi.NewServer`
và native analytics thực, với report-state cố định của fixture đã xác minh.
Không mở listener/worker, không migrate, không ghi DB. Mỗi process đo ba request
đơn và hai lượt hai request đồng thời. Cả 28 response HTTP 200, 20 items,
tổng 1.000 URL và cursor đúng; SHA body giống nhau:
`13f09e186e080403f6adfd83760c5b57876504504fb1f68ec728e4910efe04fc`.

| Mẫu warm, mỗi nhóm n=4 | Baseline median | Candidate median | Giảm |
| --- | --- | --- | --- |
| Request đơn | 604,693 ms | 453,8415 ms | 24,95% |
| Hai request đồng thời | 655,601 ms | 460,1105 ms | 29,82% |

Bỏ lượt đầu của mỗi case/process để tính warm median. Đây là microbenchmark,
không gồm Control Plane, PostgreSQL thật hoặc HTTP network; không phải p95,
capacity hoặc % cải thiện API của 150 người. Chưa đo chờ pool khi tải lớn.
Artifact: `tmp/load/phase3-handler-compare-abba.jsonl`,
`phase3-handler-compare-preflight.json`, `phase3-handler-readiness-1.json`.

Đã mở rộng patch manager cho Crawler, giữ tương thích backend/alias JarPath và
manifest cũ. Smoke test sandbox đạt install/restore, startup rollback và hash
mismatch trước stop; không dừng dịch vụ ngoài component. Collector mới dùng
execution counters, PostgreSQL read-only/timeout 2 giây/lock 500 ms; smoke test
schema 2 và kiểm tra không lộ secret đạt. Không dùng collector quét lịch sử.

- Manager SHA: `1c98c33bd8ba32fb41aa06f38e51c23ca502e47df49e7d4c93db954848f6d96a`.
- Collector mới SHA: `9235f865d432b957766604f936fbc21b050f1a98166554e4c6e529dafdf7eb75`.
- Backup Crawler gốc đã tải khỏi VPS và đối chiếu hash tại
  `tmp/load/offhost-backups/crawler-report-20260930T180954Z/original-crawler.exe`.

Lần gọi wrapper EncodedCommand quá dài không thực thi; đã chuyển sang file
script. Lần gọi file dừng vì health timeout 4 giây ở preflight, trước install,
không đổi binary/service. Artifact `phase3-crawler-install-validation.json`
của lần này là text lỗi, không phải JSON hợp lệ.

Kiểm tra lại 18:26:04 UTC: curl và Invoke-WebRequest đều HTTP 200 trên cả ba
endpoint, curl 51/371/216 ms; RAM 73,78%, sáu dịch vụ Running. Chưa tái hiện
timeout, chưa xác định lỗi client hay transient server. Backend và Crawler vẫn
hash gốc, manifest patch Crawler null, hai route synthetic tắt.
`collect-windows.ps1` đã là bản mới; `collect-windows-phase8.ps1` là bản counters
SHA `6844f929b39f6cb21db93e0e6b99c7fb1bef06c1517681c5d7081dc327f5997e`, còn
chờ đồng bộ read-only mới. Artifact `tmp/load/phase3-readiness-diagnostic.json`.

Tiếp theo: kiểm tra lại đúng preflight, triển khai riêng Crawler có backup và
rollback, đối chiếu ba report HTTP trước/sau; giữ backend gốc và 20 worker.
Trước benchmark phải đồng bộ collector, sửa harness đang trỏ backend thử nghiệm
đã rollback, thêm checksum Crawler/collector vào provenance và kiểm tra backup.
Không chạy tải lớn cho đến khi các gate đạt. Phase 3–6 chưa hoàn tất, chưa tắt máy.

### Phase 3 — Triển khai Crawler và xác minh ban đầu, 18:30–18:32 UTC

Retry preflight giữ timeout 4 giây và thêm tên port trong lỗi đã đạt. Deploy
chỉ thay Crawler sang SHA `89cb8dead8ee0fecf53e0beccab2de00f96f39cd0bde81b5e83b3ff3485e2c66`,
manifest tại `runtime/crawler-report-patch`; giữ backend gốc và worker/host 20/2.
Ba report HTTP trước: 1.041/611/588 ms; sau: 858/390/393 ms. Cả sáu HTTP 200,
20 items, tổng 1.000 và cùng body SHA. Đây chỉ là kiểm tra sau restart, không
dùng ba mẫu để tính p95 hoặc hiệu quả dưới tải. Body khác microbenchmark vì
HTTP trả report-state thực còn diagnostic dùng report-state cố định.

Collector phase8 đã đồng bộ bản read-only; snapshot 18:32:19 xác nhận Actuator,
ba PostgreSQL và hai ClickHouse available; không active scan/execution, page
queue/leases/unpublished đều 0. RAM 72,46%, CPU 7,4%, đĩa C trống 31,88 GiB.
15 browser process toàn VPS không tự chứng minh WebLens rò rỉ browser.

Đã sửa collector phân biệt browser theo executable path cài dưới `C:\WebLens\`
(bao gồm process mồ côi), path ngoài và path không đọc được. Giữ tổng browser
toàn host; thiếu path là unknown, không coi phục hồi sạch. Smoke test có browser
current/release, browser ngoài, unknown và Node; kiểm secrets/schema 2 đạt.
Collector mới SHA `dce12b3af62d3bcc44fe0a9f9aa8abbbc6d6f3765e513bedd9982bbc95fc786d`.
Harness recovery yêu cầu browser WebLens bằng 0 và attribution có dữ liệu;
browser ngoài vẫn được báo như yếu tố nhiễu tài nguyên. Không giết process ngoài.

Harness đã đổi expected backend từ patch rollback sang bản gốc, bổ sung hash
Crawler/collector và commit ứng viên vào guard/manifest. Đang tạo backup ba PG
mới và tải khỏi VPS trước khi chạy tải; chưa khởi chạy benchmark.
Artifact: `phase3-crawler-install-validation-retry.json`,
`phase3-deployed-telemetry.jsonl` trong `tmp/load`. Phase 4–6 chưa hoàn tất.

Gate trước tải: backup `performance-preflight-20260930T183646Z` đã tải khỏi VPS,
đối chiếu cả ba dump đúng dung lượng/SHA trong manifest (99.763.936 /
267.901.203 / 185.889 byte). Chỉ xác minh archive/TOC, chưa restore drill và không
bao gồm ClickHouse/R2. Hai snapshot 18:43:09/18:43:33 UTC đều đủ nguồn telemetry,
RAM 68,19%/69,24%, CPU 2,9%/3,2%, backlog/lease/unpublished bằng 0. Browser toàn
host, WebLens, ngoài và unknown đều 0; khác mẫu 18:32 có 15 browser, không có
hành động giết process từ agent. Ghi nhận thay đổi tải ngoài khi so baseline.
Artifact `tmp/load/phase3-deployed-telemetry-attributed.jsonl`.

Lượt tiếp dùng wrapper `-RunLabel report-after-20 -WorkerConcurrency 20`,
state `tmp/load/phase8-scheduled-state-report-after-20.json`. Harness còn kiểm
hai mẫu readiness và RAM <80%/CPU <50% trước admission; không nới guard.

Wrapper đã bắt đầu lúc 18:47:45 UTC, run `20260930T184745Z`, session `47479`;
artifact `tmp/load/phase8-report-after-20-150x1000-20260930T184745Z`.
State hiện `RUNNING` (gồm gate/seed/admission, chưa tự chứng minh đã nhận 150
scan). Theo dõi manifest, submission và progress để xác nhận giai đoạn thực.
Không khởi chạy bài khác hoặc đổi service/config trong khi wrapper hoạt động.

#### Lượt 18:47 dừng trước admission

Run `20260930T184745Z` kết thúc `FAILED_RESTORED` lúc 18:54:00 UTC. K6 setup
đăng nhập 79 lần; account index 78 nhận HTTP 0/timeout 5 giây lúc 18:52:37,
exit 107. Chưa có admission/check/scan nào và chưa chạy mixed API; các threshold
hiển thị đạt trên zero sample không có giá trị xác nhận. Không dùng lượt này
để tính capacity hoặc % cải thiện. Harness original để manifest `RUNNING` khi
throw; wrapper state mới là bằng chứng kết thúc. Đã bổ sung catch ghi manifest
`FAILED` cho các lượt sau, giữ guard và timeout.

Mười mẫu VPS 18:50–18:52: RAM 67,54–69,39%, CPU 1,8–23,2%, Hikari pending 0,
không active scan/execution, queued/leased/unpublished 0. Không có bằng chứng
saturation từ các mẫu này; chưa xác định nguyên nhân timeout auth. Telemetry
đã tải thành `tmp/load/phase3-failed-setup-vps.jsonl`.

Recovery 18:54:25: curl và IWR cả ba health HTTP 200, RAM 68,08%, sáu services
Running, hai route synthetic tắt; backend gốc/Crawler ứng viên đúng hash.
K6 và wrapper đã thoát, không còn workload test. Giữ ứng viên Crawler vì lỗi
nằm ở login setup, chưa có evidence regression của report; không nới timeout.
Chỉ thử lại một lượt cùng workload sau các gate; nếu lại lỗi setup thì cần
chẩn đoán đường request trước tải lớn tiếp. Artifact recovery:
`tmp/load/phase3-readiness-after-setup-failure.json`. Chưa hoàn tất Phase 3–6.

Đã đối chiếu sửa manifest lượt cũ thành `FAILED_PRE_ADMISSION`, thêm
`failureReconciledFrom`; không đổi raw k6/telemetry. Private seed đã được xóa
trong cleanup. Lượt thử lại duy nhất bắt đầu 18:57:48 UTC:
`20260930T185748Z`, session `61040`, artifact
`tmp/load/phase8-report-after-20-retry-150x1000-20260930T185748Z`, state
`tmp/load/phase8-scheduled-state-report-after-20-retry.json`. Giữ timeout,
workload và runtime; đang qua gate/seed. Không chạy song song lượt cũ đã thoát.

#### Retry 18:57 không đạt admission; cần đối chiếu scan khi client timeout

Setup đăng nhập đủ 150 nhưng admission chỉ 121/150 trả 202; 29 request lỗi.
Admission p95 4.796,85 ms, median 3.473,03 ms, error rate 19,33%; k6 exit 99.
Chưa chạy mixed API; harness guard `admission_count_mismatch` hủy 121 scan đã
biết ID. Không diễn giải đây là report regression, vì chưa gọi report ứng viên
trong workload. Không tăng worker hoặc chạy thêm lượt tải trước chẩn đoán.

Đã lưu 150 website ID từ seed trước cleanup (không password/token). Probe PG
read-only/2 giây theo index website xác nhận lúc 19:09:48 UTC **DB tạo đủ 150
scan**: 117 CANCELLED, 4 CANCEL_REQUESTED, 29 QUEUED. 29 scan ứng với request
timeout không có ID ở client nên harness chưa hủy chúng. Không coi admission
timeout là transaction chưa commit. Artifact `phase3-admission-reconcile.json`
ban đầu có wrapper JSON `value`/`Count` của PowerShell; đã xác minh 150 row
trong `scans[0].value`, không dùng outer count 1 để kết luận.

Đang cleanup riêng 29 scan không được client ghi nhận qua command cancellation
hiện có của Crawler: lookup đúng scan/owner từ 150 website của run, đọc command
version hiện hành rồi gửi version kế tiếp, giữ inbox/lease/fencing và delivery
event về Control Plane. Không update trực tiếp DB hoặc tự gán trạng thái terminal.
Chưa xác nhận mọi scan đã terminal/recovery. Wrapper session 61040 còn hoạt động;
không restart dịch vụ, rollback hoặc tắt route thủ công trong khi cleanup đang chạy.
Không khởi chạy lượt thứ ba. Phase 3 chưa có benchmark đầy đủ; 4–6 chưa hoàn tất.

Wrapper đã kết thúc `FAILED_RESTORED` 19:14:59 UTC, guard
`admission_count_mismatch`: 121 scan được client ghi nhận đều CANCELLED,
2.891 trang processed từ các scan bị hủy; không phải 150.000 trang hoàn tất.
Có 51 mẫu VPS/107 mẫu generator, mọi nguồn telemetry đọc được. VPS CPU max
19,8%, RAM max 72,08%; generator CPU max 17%, RAM max 64,15%. Hikari active
max 10 (hết pool), pending max 29, timeout delta 0; Tomcat busy max 40 và lock
chờ max 3 ở cả Control Plane/Crawler. Đây là bằng chứng chờ pool/lock trong
burst admission, chưa phân biệt transaction dài hoặc SQL/lock nào gây ra.
Không đủ để quy lỗi cho report song song vốn chưa được gọi trong lượt.

Snapshot cuối wrapper còn 29 active scan/execution, 2.152 page queued, nên
`FAILED_RESTORED` chỉ chứng minh route phục hồi, không phải workload sạch.
Cleanup nội bộ lúc 19:16:24 trả COMMAND_ACCEPTED cho đủ 29 scan; đây là ACK,
chưa tự chứng minh tất cả terminal. Đang probe đối chiếu lại 150 scan/global
backlog bằng partial indexes và readiness trước bất kỳ restart/rollback nào.
Artifact `phase3-unknown-admissions-cancel.json`; raw manifest của lượt retry
giữ số scan client quan sát, bổ sung DB reconciliation riêng thay vì sửa thành
150 thành công. Không chạy thêm tải hoặc tăng worker.

#### Recovery hoàn chỉnh và rollback

Probe 19:21:17 xác nhận đủ 150/150 CANCELLED, global active executions,
queued/leased/persisting pages, host leases và analytics backlog đều 0;
ba endpoint 200, hai route tắt. Chỉ sau đó mới restore Crawler qua patch manager.
Hash khôi phục đúng `2684ca92f4ce958c1261f8f7d93e3da74d810e1997fb7de61b526b2780531de4`;
backend giữ bản gốc. Không giết tiến trình ngoài hoặc cập nhật trạng thái DB trực tiếp.

Recovery sau rollback 19:25:33: đủ 150 CANCELLED; global Control Plane active
scans/outbox backlog 0; Crawler active/page queue/lease/analytics backlog 0.
Curl và IWR ba health đều HTTP 200, RAM 67,54%, hai route synthetic tắt.
Artifact `phase3-post-admission-recovery.json`, `phase3-crawler-restored.json`,
`phase3-post-rollback-recovery.json`. Manifest patch Crawler giữ `restored=true`
và backup, không xóa bằng chứng. Không tắt máy vì Phase 3–6 chưa hoàn tất.

Rà luồng `ScanController → ScanService.create → CurrentUserService.lockActive →
WebsiteAccessService.lockOwnedActive → ScanRepository → outbox` bằng
`jpa-query-reviewer`: transaction giữ user/website locks đến commit, có truy vấn
idempotency, exists/count quota, saveAndFlush và enqueue. Chưa có timing/query
plan dưới burst để gán stage nào là nguyên nhân. `requirePublicTarget` chỉ
kiểm hostname/IP literal; hostname `phase5-NNN.jobnext.top` không chạy DNS ở
nhánh này. Không kết luận DNS giữ connection, N+1 hoặc thiếu index từ pool wait.
Giữ quyền owner, quota và lock đảm bảo consistency; chưa sửa runtime admission.

Việc tiếp theo trước tải lớn: sửa harness lưu identifiers bền vững và đối chiếu
mọi timeout bằng idempotency/website trước cleanup; xác nhận mẫu telemetry thật
trước admission, ghi mixed API chưa chạy khi thiếu admission. Chẩn đoán thời gian
acquire connection, transaction và SQL/lock ở admission bằng phép đo có giới hạn;
chỉ tối ưu khi có bằng chứng. Nếu deploy lại ứng viên, phải xử lý manifest đã
restored bằng quy trình giữ backup/provenance, không xóa để vượt guard. Giữ
backend/Crawler gốc, worker 20/host 2; chưa có before/after workload hoàn chỉnh.

#### Sửa đối chiếu admission và kiểm tra gate — 19:33–20:18 UTC

Đã sửa local harness `tmp/load/phase8-run-150x1000.ps1` để lưu identifiers công
khai sau từng website và request identity/idempotency key trước admission. Sau
timeout hoặc exception, harness đọc lịch sử scan bằng API của đúng account và
website mới của run, đối chiếu UUID/website/thời điểm rồi thêm ID tìm được vào
cleanup. Không POST lại admission, không tính ID tìm lại thành request thành
công. Trường hợp không đọc được, nhiều row, sai website hoặc chưa thấy row đều
giữ `UNRESOLVED`; một GET chưa thấy row không chứng minh transaction sẽ không
commit sau đó. Reconciliation và terminal cleanup chạy trước khi xóa private
seed/credentials. Ghi riêng `submission-observations.json`,
`admission-reconciliation.json`, `cleanup-scans.json` và `cleanup-state.json`.

Trước admission, xác nhận website chưa có scan và kiểm tra ít nhất hai mẫu
telemetry liên tiếp thực sự đọc được từ cả VPS và generator, đúng schema,
không cũ, không quá guard, nguồn PostgreSQL/Actuator/ClickHouse available,
services chạy và không có active workload/page queue/host leases. Process
collector đang sống không còn là bằng chứng đủ. Mixed API giữ `NOT_STARTED`
nếu admission/k6 không đạt; giữ timeout và SLO cũ. Cleanup được đối chiếu theo
scan đã quan sát cả ở client và server, không chỉ theo 121 response thành công.

Wrapper `tmp/load/phase8-scheduled-run-150.ps1` đã bỏ cách gán
`FAILED_RESTORED` chỉ từ route off. Bản local mới yêu cầu run terminal/identity
đủ và hai proof global recovery, cách nhau 15 giây; nếu thiếu ghi
`RECOVERY_UNVERIFIED`, không tự khẳng định phục hồi sạch. **Gate global này
vẫn đang hoàn thiện, chưa dùng để chạy tải mới.** Verifier độc lập
`tools/load/verify-performance-recovery-windows.ps1` chỉ đọc, không đổi
runtime/schema/grants; PG vẫn timeout 2 giây/lock timeout 500 ms. Có chế độ
`-ExplainOnly`, không `ANALYZE`.

Kiểm thử `tools/load/phase8-harness-smoke-test.ps1` đạt: mô phỏng 150 request
gồm 121 ACK và 29 timeout đã commit, đối chiếu/hủy/xác nhận terminal đủ 150;
kiểm đúng owner, không replay POST, không sửa lỗi client, từ chối history mơ
hồ/sai website/row cũ/unavailable và telemetry thiếu/cũ/lặp/quá tải/backlog.
Không dùng mạng trong kiểm thử. Parser của harness/wrapper/verifier đạt.
Chưa chạy admission hoặc tải production để thử các thay đổi này.

Phân tích lại raw k6 của `20260930T185748Z`, 150 admission observations:

| Timing phía client | Median | p95 |
| --- | ---: | ---: |
| `http_req_blocked` | 229,28 ms | 309,63 ms |
| `http_req_connecting` | 69,23 ms | 79,54 ms |
| `http_req_tls_handshaking` | 157,70 ms | 230,71 ms |
| `http_req_waiting` | 3.472,50 ms | 4.796,85 ms |
| `http_req_duration` | 3.473,03 ms | 4.796,85 ms |

Artifact `tmp/load/phase3-admission-client-timings.json`. Blocked đã gồm phần
kết nối/TLS; không cộng các percentile. Có 29 timeout cắt ngắn quan sát, nên
đây không phải thời gian transaction/SQL, không suy ra độ trễ server nếu
không timeout. Waiting gồm proxy/server/network. Bằng chứng tập trung phép đo
tiếp vào đường xử lý admission và chờ pool; chưa chứng minh SQL/lock cụ thể.
Mixed/report chưa chạy, không có before/after hay capacity mới.

Probe recovery đầu chạm `statement_timeout`; đã dừng, chỉ dùng EXPLAIN không
thực thi để rà plan. `tmp/load/phase3-recovery-query-plans.json` cho thấy truy
vấn kiểm toàn cục `scan_pages.status='PERSISTING'` và event outbox gồm `DEAD`
chọn Seq Scan trên lịch sử tháng 9/outbox. Đây là vấn đề của phép kiểm tra mới,
không phải bằng chứng nguyên nhân admission. Không chạy lại hai count đó,
không tăng timeout hoặc thêm index. Bản verifier sửa dùng persisting counter
của active executions và partial indexes PENDING/CLAIMED cho event outbox;
để `eventDeadBacklog=null` và ghi rõ orphan PERSISTING chưa đối chiếu. Vì còn
hai giới hạn này, `globalRecoveryVerified=false`; không coi null là 0.

Một probe readiness gặp curl timeout 5 giây; verifier đã sửa xử lý native
stderr Windows PowerShell để ghi lỗi health thay vì dừng mất proof. Probe
20:10:57 UTC chạy thành công: cả ba health UP, sáu services Running, RAM
66,77%, hai route off, backend/Crawler hash gốc, browser WebLens/external/
unknown đều 0. Control active scans/outbox 0; Crawler active executions,
queued/leased, active persisting counter/host leases/analytics backlog và
event PENDING/CLAIMED 0; Capture active jobs/analytics/event backlog 0.
Artifact `tmp/load/phase3-harness-recovery.json`. Chỉ kết luận các nguồn đã
đo phục hồi; không cấp chứng nhận global sạch khi hai kiểm tra còn thiếu.

Việc tiếp: hoàn thiện phép kiểm backlog chọn lọc có đủ bằng chứng, đo riêng
acquire/transaction/SQL/lock tại admission bằng phương án nhỏ có giới hạn.
Chưa deploy instrumentation backend, chưa chọn tối ưu admission, chưa chạy
workload mới hoặc tăng worker. Phase 3–6 còn mở; không tắt máy. Automation
tiếp tục và giữ điều kiện kiểm mọi task khác trước shutdown.

#### Hoàn thiện diagnostic local — 20:22–21:04 UTC

Chưa chạy workload mới, deploy ứng viên, tăng worker, đổi cấu hình, schema hoặc
grants. Backend/Crawler production vẫn bản gốc. Phase 3–6 chưa hoàn tất.

**Phép kiểm PERSISTING chọn lọc chưa đạt.** Artifact
`tmp/load/phase3-indexed-recovery-plans.json` lúc 20:30:24 ghi execution estimate
846, heap 901.120 byte; partition tháng 9 dùng index
`scan_pages_2026_09_execution_id_status_id_idx` với execution/status, các
partition tương lai có Seq Scan cost 0. Một audit toàn roster và một audit chia
32 execution/batch đều thất bại; lượt batch xác định SQLSTATE `57014`
(statement timeout 2 giây). Không có proof `phase3-indexed-persisting-proof.json`
thành công; chưa biết batch nào timeout vì bản cũ không lưu tiến độ. Index trong
EXPLAIN không bảo đảm thời gian thực thi. Không lặp lại audit hoặc tăng timeout.

Phát hiện thêm lỗi ở gate plan: PowerShell có thể bọc EXPLAIN trong `value/Count`,
khiến cách đọc `.Plan` cũ bỏ qua node. Đã thêm `Get-ExplainPlans` để nhận cả hai
dạng và từ chối dạng thiếu/không hiểu; gate từ chối Seq Scan lịch sử, node thiếu
hoặc cost chưa biết. Scratch probe nay lưu offset, SQL/plan và completed batches
trước mỗi lần thực thi; lỗi giữ `FAILED_UNVERIFIED`. Smoke test không dùng mạng
đạt trên Windows PowerShell và PowerShell 7, gồm plan bọc có Seq Scan phải bị
chặn. Verifier/probe đã upload chỉ làm diagnostic; **không thực thi lại audit**.

Catalog Crawler event outbox có live tuple estimate 1.437.930 và MVCC dead tuple
estimate 161.222; **MVCC dead tuple không phải event có status DEAD**. Index hiện
có cho PENDING/CLAIMED/DELIVERED, chưa có đường lookup DEAD theo status. EXPLAIN
DEAD chọn Seq Scan cost 181.006,42, estimated matching rows 20; đây không phải
actual count. Không thực thi query DEAD hoặc thêm index. Hai thiếu sót recovery
global vẫn giữ nguyên; không đổi unknown thành 0.

**Bản đo admission đã đóng gói local, chưa deploy.** Nhánh
`codex/performance-admission-timing` tại checkout riêng
`C:\Users\HP\.codex\worktrees\performance-metrics\Pet_project`, base production
`9e87e8b0c95ea1791dcc4814793e45b1e391ca36`, commit
`044fa4f8a9d3a24394c396ddbc49a1498bfb4238`. Nhánh này không chứa patch
NOT_SUPPORTED `be63961`; nhánh report `codex/performance-queue-api` vẫn giữ riêng.
Chỉ thay `ScanController.java`, `ScanService.java` và thêm
`ScanAdmissionTimingTest.java`; không đổi query, transaction annotation, owner,
user/website locks, quota, idempotency, SSRF hoặc atomic outbox.

Logger riêng `com.weblens.scan.admission` chỉ đo khi DEBUG được bật. Mặc định INFO
không tạo đối tượng timing hoặc đăng ký callback. Đo body theo stage user lock,
website lock, validation, idempotency, website active/quota, saveAndFlush, outbox
và response; ghi correlation/scan UUID, outcome và trạng thái transaction trong
`afterCompletion`. Controller đo khoảng gọi service qua Spring proxy. Không log
credentials, key, user/email, URL đích hoặc SQL binds. Log có overhead; nếu sau
này bật thì chỉ trong cửa sổ diagnostic có giới hạn rồi tắt.

`callMs` gồm proxy begin/commit/cleanup; body bắt đầu sau proxy đã vào method.
`completionAfterBodyMs` kết thúc tại callback, không phải toàn bộ cleanup. Không
coi chênh lệch call/body là thời gian acquire connection hoặc SQL. Có 9/9 tests
đạt (ScanServiceTest 6, ScanAdmissionTimingTest 3), build/package đạt;
`git diff --check` và UTF-8 đạt. Đây là unit tests, chưa chứng minh hành vi
Spring proxy/DB thực hoặc giảm latency. Artifact local
`tmp/load/phase3-backend-admission-timing-044fa4f.jar`, 65.963.399 byte, SHA256
`3bf710bc5c84dcf4480f0a647f2b8fa81779a5f1306f2e789a94062ceb2d614a`;
provenance `tmp/load/phase3-admission-timing-provenance.json`.

Probe chỉ đọc 21:03:54 xác nhận Actuator đã expose
`hikaricp.connections.acquire` và `.usage`, pool `HikariPool-1`, baseUnit seconds,
COUNT/TOTAL_TIME/MAX có sẵn; không cần đổi runtime để có metric này. Giá trị hiện
tại là thống kê tích lũy toàn pool, không phải admission burst hoặc p95; không
dùng MAX/mean hiện tại để so baseline. FK validated thực tế là
`(execution_id, owner_id, retention_month)` đến `crawl_executions`, do đó lookup
cùng execution/month có căn cứ về month coverage. Đây không chứng minh backlog
rỗng. Artifact `tmp/load/phase3-admission-measurement-readiness.json`.

Health 21:00:11: backend UP, Crawler/Capture curl timeout 5 giây; cả sáu service
Running, RAM 66,81%, routes off, hashes gốc, backlog đã đo 0, global proof vẫn
false. Recheck 21:01:43: curl cả ba HTTP 200/body UP, IWR cả ba HTTP 200,
RAM 66,70%, hashes/collector không đổi, routes off. Không suy service DOWN từ
một timeout hoặc suy stability dài hạn từ một recheck. Artifact
`tmp/load/phase3-recovery-20260930T210011.json`,
`tmp/load/phase3-readiness-20260930T2100.json`.

Việc tiếp theo:

1. Giải quyết hai scope recovery chưa đo bằng kế hoạch có giới hạn. Không chạy
   lại count lịch sử hoặc audit batch cũ. Nếu cần index mới, chuẩn bị workload/
   chi phí ghi/retention theo DESIGN_GATES và xin đúng review trước migration.
2. Chuẩn bị validation nhỏ cho bản đo admission, chỉ deploy khi gate được giải
   quyết và có backup/hash/rollback. Kiểm proxy/commit bằng request được đối
   chiếu; replay chỉ đo đường replay, không đại diện save/outbox của create mới.
3. Thu Hikari acquire/usage trước/sau với cùng pool/uptime, cùng correlation logs
   và bounded PG wait/lock snapshot, không log SQL binds. Delta COUNT/TOTAL_TIME
   chỉ cho mean của mọi acquisition trong cửa sổ, có background traffic; không
   phải timing từng admission hoặc p95. Chưa chọn tối ưu từ pool pending một mình.
4. Chỉ quay lại benchmark cùng workload khi harness/recovery/telemetry đạt;
   giữ SLO/timeout và guard. Phase 4–6 và điều kiện shutdown tiếp tục còn mở.

#### Catalog chọn lọc và phạm vi review recovery — 21:15 UTC

Đã đọc catalog/statistics bằng helper PG read-only/2 giây; không chạy lại count
lịch sử hoặc audit batch. Snapshot `tmp/load/phase3-recovery-catalog-20260930T2112.json`
lúc 21:15:27: page tháng 9 estimate 529.758 live tuples, heap 194.101.248 byte,
index 262.914.048 byte; event outbox estimate 1.437.930 live tuples, heap
1.421.230.080 byte/index 339.795.968 byte. Parent scan_pages estimate 0 không
đại diện dữ liệu các partition. Các execution/status indexes đều valid/ready.

Mẫu activity hiện tại: ba session khác, không xact_start đang mở được quan sát,
idle-in-transaction/lock wait/IO wait đều 0. Không gán timeout cũ cho bloat,
autovacuum hoặc contention từ mẫu này. Các count scan/index từ pg_stat là tích
lũy; không suy throughput hiện tại hoặc query cụ thể từ chúng.

Đã chuẩn bị `docs/database/PERFORMANCE_RECOVERY_MONITORING_REVIEW.md`, revision 1,
để review phạm vi hai index logic giám sát DEAD và PERSISTING. Có kiểm kê
workload/đọc/ghi/volume/consistency/retention, trade-off, validation và giới hạn
runner transaction/partitioned index. Chưa viết migration hoặc DDL thực thi,
chưa đổi schema/grants/runtime. Theo DESIGN_GATES cần review riêng trước bước
thiết kế/triển khai DB tiếp. Không xem quyền chạy toàn bộ phases là tự duyệt index.

Global proof vẫn thiếu hai scope; các phase 3–6 còn mở. Chưa có throughput,
latency hoặc capacity mới; không chạy tải, deploy instrumentation hoặc tắt máy.

#### Kiểm thử Spring proxy local và review đang chờ — 21:25 UTC

Đã bổ sung một kiểm thử vào `ScanAdmissionTimingTest` chạy method create qua
Spring TransactionInterceptor và annotation transaction thực, dùng transaction
manager không có DB. Kiểm cả commit thành công và commit thất bại phải rollback:
body outcome NEW_SCAN đi cùng trạng thái COMMITTED hoặc ROLLED_BACK đúng, log chỉ
xuất sau completion, không chứa key/URL/user/website, thread transaction được dọn.
Không thực thi DB, HTTP hoặc workload production. **10/10 tests đạt** (service 6,
timing 4), diff check và UTF-8 đạt. Commit chỉ thêm test
`15455ab36b71ba9e791d457d28c31339372b7c88`; production code/JAR candidate từ
`044fa4f` không đổi. Không dùng thời gian của mock làm kết quả latency thực.

Đã gửi yêu cầu review phạm vi revision 1 của
`PERFORMANCE_RECOVERY_MONITORING_REVIEW.md`, giải thích DESIGN_GATES yêu cầu review
riêng trước thay đổi DB. Đang chờ câu trả lời; chưa có phê duyệt index/migration/
triển khai, không lặp lại câu hỏi trong mỗi heartbeat. Trong lúc chờ chỉ tiếp tục
việc local có rủi ro cụ thể cần giải quyết hoặc probe vận hành có giới hạn; không
thực hiện DDL, chạy tải hoặc bỏ gate recovery để tiến phase.

Probe 21:27:12 lặp lại timeout curl ở hai worker trong verifier; backlog đã đo
0, RAM 66,82%, hashes gốc, sáu service Running và routes off. Recheck độc lập
21:28:54 lại có curl/IWR cả ba HTTP 200, RAM 66,68%. Artifact
`tmp/load/phase3-recovery-20260930T2125.json` và
`tmp/load/phase3-readiness-20260930T2127.json`. Sự khác nhau giữa hai kiểu probe
chưa giải thích được; không bỏ lỗi để cho recovery gate đạt. Nếu điều tra tiếp,
cần phép so sánh request/timing có giới hạn trước khi kết luận runtime DOWN,
query admission hoặc ClickHouse là nguyên nhân; không restart để thử.

#### So sánh request health có giới hạn — 21:37–21:42 UTC

Đã thực hiện hai phép so sánh nhỏ, mỗi phép sáu GET health localhost, không gửi
admission hoặc report/crawl và không thực thi query DB trong script so sánh.
Cùng URL/timeout 5 giây/write-out/parser: captured loop so với flat loop, sau đó
URL nội suy trực tiếp giống verifier so với URL truyền qua biến. Cả 12 request
HTTP 200/body UP, curl exit 0. Script chạy Windows PowerShell 5.1.17763.2931.
Không tái hiện timeout từ riêng cách viết loop hoặc URL; **chưa xác định nguyên
nhân timeout cũ**, không kết luận lỗi PowerShell/parser hoặc service đã được sửa.
Artifacts `tmp/load/phase3-health-request-comparison.json` và
`tmp/load/phase3-health-inline-url-comparison.json`.

Verifier chỉ bổ sung metadata mỗi request: URL, startedAtUtc, elapsedMs và
httpCode; giữ nguyên curl arguments, timeout và điều kiện exit 0/HTTP 200/body UP.
Không retry tự động hoặc bỏ failure để gate đạt. Smoke test offline harness/
EXPLAIN đạt; UTF-8 đạt. Đã đồng bộ helper diagnostic lên VPS, không thay service/
runtime. Verifier SHA256 mới
`ee594e0578ea0a8dad4d964b57ffd22b49f13888ad10668c50a3fb1dff02e60b`.

Full verifier lúc 21:41:46: ba health HTTP 200/body UP; elapsed có overhead
process lần lượt 107/423/509 ms, không phải latency API dưới tải. RAM 66,85%,
sáu services Running, browsers 0, hai routes off, hashes backend/Crawler gốc;
mọi backlog trong scope đã đo 0. `observedWorkloadRecovered=true` nhưng
`globalRecoveryVerified=false` do hai scope chưa được đo. Artifact
`tmp/load/phase3-recovery-health-timings.json`. Không chạy mẫu tải hoặc diễn giải
một proof thành stability dài hạn. Review index revision 1 vẫn đang chờ; không
hỏi lại, không thực hiện DDL/deploy hoặc tắt máy.

## Điều cần hiểu trước khi chấp nhận code

Spring transaction giữ kết nối DB sau truy vấn đầu tiên đến cuối transaction.
Khi chờ HTTP bên ngoài trong transaction, các request khác có thể phải chờ pool.
`NOT_SUPPORTED` suspend transaction caller; các thao tác đọc phân quyền kết thúc
trước khi gọi crawler. Quyền owner và trạng thái tài khoản vẫn được kiểm tra.

Worker crawler là số trang có thể xử lý đồng thời, không phải số người dùng;
tốc độ còn chịu giới hạn host, dispatcher, PostgreSQL và analytics delivery.
Mỗi thay đổi phải được đo độc lập; độ trễ hàng đợi và thời gian nhận kết quả
là hai chỉ số riêng. Chỉ công bố cải thiện và capacity sau khi đối chiếu dữ liệu.

Client timeout không rollback transaction trên server. Idempotency và đối
chiếu đúng owner/website giúp tìm lại kết quả; ID phục hồi không làm request
timeout trở thành thành công. Kiểm tra recovery cũng phải đo chi phí query:
count có filter vẫn có thể quét toàn lịch sử, còn counter có scope hẹp không
tự chứng minh không có orphan hoặc DEAD event ngoài scope đó.

Method trả response chưa chứng minh transaction commit. Log outcome của body
phải đi cùng trạng thái afterCompletion; timing controller bao gồm proxy nhưng
không tự phân tách pool acquisition. Instrumentation mặc định tắt và vẫn phải
được kiểm tra overhead trong phép đo nhỏ trước khi dùng để kết luận hiệu năng.

## Đối chiếu kết quả cuối — 2026-10-03 01:55 giờ local (2026-10-02 18:55 UTC)

Lượt `worker64-500-after-claimfix` đã dừng. Manifest gốc giữ `FAILED`,
stop reason `harness_exception_see_primary_failure`; wrapper giữ
`RECOVERY_UNVERIFIED`. Lỗi harness tại dòng 1013 là hết thời gian chờ 180 giây
cho tiến trình SSH collector; level summary chưa được ghi, không phải API có
0 request. Mục tự động trước đây thiếu dữ liệu đã được thay bằng đối chiếu này.
Không sửa outcome gốc hoặc biến lỗi thành thành công.

`500-scans/scans.json` chỉ có 498 terminal. Bằng chứng cuối
`500-scans/cleanup-scans.json` có **500 ID riêng biệt: 464 COMPLETED, 36 CANCELLED**.
Đã assert đối chiếu tập scan ID, index và accountIndex với 500 admission HTTP202
và request identities. Hai scan bổ sung trong cleanup đều COMPLETED.
464.000/500.000 trang processed và succeeded, 0 failed trên projection; cả36
projection bị hủy có startedAt=null và processed0. Audit bổ sung phía Crawler
ở mục đầu báo cáo đã đính chính: đủ500execution thực sự đã chạy và hoàn tất.

First started 10:10:06 UTC, last finished 18:22:10 UTC; observed wall
29.523,985 giây, **15,7160 projected succeeded pages/s**, bao gồm độ trễ apply
event và thời gian chờ terminal sau hạn8h; không phải throughput worker. Không gọi
đây là throughput hoàn tất 500 scan hoặc capacity
1.000 người. Trong 464 scan đã bắt đầu, queue wait median 14.352,39 giây,
p95 27.385,65 giây, max 28.817,91 giây; 36 scan chưa bắt đầu không nằm trong
percentile này. Fairness và thời gian chờ dài vẫn chưa được giải quyết.

API chỉ chạy 10 phút lúc 17:10–17:20 ngày 02/10 giờ local, không chạy suốt
8 giờ crawl: 64.850 request, 1.947 lỗi (3,0023%), p95 5.703,58 ms, k6 exit99.
Admission HTTP p95 99,55 ms nhưng client elapsed p95 3.908,15 ms vẫn không đạt.
Giữ nguyên lỗi startup/login, timeout pool ClickHouse và hai polling failures;
không loại hai phút đầu hoặc đổi SLO để chấp nhận kết quả.

Cleanup runTerminalVerified=true; private seed/DPAPI đã được harness xóa sau
terminal reconciliation. Mẫu telemetry cuối 18:22:07 UTC ghi không còn active
Control Plane/Crawler, page queue/lease/PERSISTING và analytics unpublished
trong active scope bằng 0; đây là mẫu cuối, không phải xác minh global recovery.
18:53–18:54 UTC xác minh remote collector PID10256 đã thoát, wrapper30516 đã
thoát và hai marker routes test đều off. Local SSH collector PID35880 vẫn còn
sau khi remote collector thoát; đã xác minh parent30516 và encoded command
đúng run rồi dừng riêng tiến trình SSH đó lúc 18:54:51 UTC. Không restart service,
thay runtime, can thiệp task khác hoặc phát workload mới.

Proof: `final-cleanup-analysis.json` trong run directory
`tmp/load/phase8-worker64-500-after-claimfix-500x1000-20261002T095900Z/`;
telemetry thu hồi `500-scans/vps-recovered.jsonl`; các proof trong
`tmp/load/diagnosis-500-20261002/`: `claimfixed500-exit-route-proof.json`,
`claimfixed500-routes-off-proof.json`, `claimfixed500-local-exit-proof.json`.
Global DEAD/orphan PERSISTING vẫn unknown. Automation PAUSED, review index
revision1 pending; mục tiêu 1.000 còn chờ phạm vi, không shutdown.
Phương án API ở mục 13:43 đã được cho phép nhưng chưa triển khai trong lần kiểm này.

## 2026-10-03 — Code tối ưu tiếp tại local

Người dùng đã yêu cầu sửa report API, điều phối crawl và event lag. Đã thêm
shortcut report rỗng dựa trên workflow Crawler; pool đọc 7/ghi 3 trong tổng 10,
admission deadline/timing; tối đa 4 claim song song và phân phối theo lease/activity;
snapshot progress tối đa một lần/giây/scan cùng trạng thái, giữ đổi trạng thái và
terminal; publisher song song 4 scan, ack có outcome và lease fencing.

Go test/vet/build PASS, 14 integration Crawler trên PostgreSQL test 18.4 PASS;
16 test Java liên quan PASS, gồm 5 cancellation integration. Chưa deploy hoặc
đo lại production. ClickHouse integration thật, PostgreSQL 17 và race detector
còn cần môi trường phù hợp. Các số tải cũ không được thay bằng mục tiêu kỳ vọng.
Chi tiết, thay đổi, lệnh chạy, rủi ro và các bước đo tiếp:
[PERFORMANCE_RUNTIME_FIX_2026-10-03.md](PERFORMANCE_RUNTIME_FIX_2026-10-03.md).
Automation PAUSED, review index revision 1 pending, phạm vi 1.000 còn chờ;
global DEAD/orphan PERSISTING unknown, giữ máy bật.

### Kiểm chứng candidate tiếp theo ngày 03/10/2026

Đã hoàn thành môi trường local PostgreSQL 17.6/ClickHouse 26.3.39.7: toàn bộ Go
suite với race detector PASS (105 test/subtest action, 0 skip), Go vet/build PASS;
Backend 36 unit và 14 integration PASS, không fail/error/skip. Foundation API,
persistence, authentication và cancellation đã chạy trên DB thật riêng.

Candidate `91f1d35e0944573af7904648908b58430dd56f4f` giữ baseline crawler
`ceb3a76` và backend production `56b0660`; không build checkout chính cũ để tránh
mất patch đã deploy. Hai artifact, source patch, hashes và evidence đã lưu trong
`tmp/releases/runtime-verified-20261003/manifest.json`. Test containers/daemon
đã thoát, các port test không còn listener. Chi tiết nguồn/rủi ro/trình tự triển
khai và đo 25 → 100 → 500 ở báo cáo runtime fix phía trên.

Chưa deploy hoặc có workload production mới; chưa đo hiệu năng sau sửa. Kết quả
500 cũ giữ nguyên. Automation PAUSED; phạm vi 1.000, index review và global
unknown giữ nguyên; Windows vẫn bật.

### Đã triển khai candidate ngày 03/10/2026, xác minh cuối 06:09 UTC

Đã deploy backend rồi crawler từ `91f1d35e0944573af7904648908b58430dd56f4f`.
Hash production khớp candidate: backend `e4bbd656...`, crawler `7acd544f...`.
Service XML/config và schema không đổi. Smoke API public đạt: scan một trang có
report fresh, cancel đi qua CANCEL_REQUESTED rồi CANCELLED. Đối chiếu ba identity
gồm attempt harness đầu đã cleanup: Control/Crawler status/version/owner khớp,
outbox cuối DELIVERED và inbox APPLIED cùng message/version. Scope smoke backlog 0,
website đã archive; private seed giữ tại ignored tmp.

Final health ba service HTTP 200/body UP, bốn service ứng dụng Running; active
scans/executions 0, routes/hosts tải off, không thấy process test/collector đã kiểm.
Evidence và rollback commands tại `tmp/releases/runtime-verified-20261003/manifest.json`,
trạng thái `DEPLOYED_SMOKE_VERIFIED`. Không có benchmark sau sửa; số tải 500 cũ
giữ nguyên. Global unknown, phạm vi 1.000, index review và automation PAUSED giữ nguyên.

### Bắt đầu lượt 150 scan + 150 API ngày 03/10/2026, 06:26 UTC

Người dùng xác nhận đo đồng thời: 150 tài khoản, mỗi người tạo một scan 1.000
trang (150.000 trang yêu cầu), cùng 150 VU API dùng chính 150 tài khoản trong 10 phút.
Run label `worker64-150-runtime-v1`, run ID `20261003T062608Z`; wrapper PID 41140.
Worker64/host2/delay1s và cấu hình production giữ nguyên. Runtime backend/crawler
đúng candidate `91f1d35...`; manifest lưu hai binary hashes đầy đủ. Trần quan sát
crawl 28.800 giây, giữ admission5s/API10s và SLO p95<1s/errors<1%, startup/login
errors, owner/identity reconciliation và terminal cleanup.

State: `tmp/load/phase8-scheduled-state-worker64-150-runtime-v1.json`.
Active proof: `tmp/load/runtime150-active-run.json`.
Evidence: `tmp/load/phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z/`.
150 public identifiers đã ghi; chưa dùng việc seeding đủ để tuyên bố đủ admission.

Dùng bản sao harness/wrapper riêng, giữ nguyên script lịch sử và expected runtime
mới. Bản sao suppress remote progress/OutputFormat Text, thêm SSH keepalive, lưu
collector PIDs và kiểm lệnh tạo stop file. Đây là cải thiện điều khiển collector;
chưa chứng minh lỗi kết thúc collector của lượt 500 đã được giải thích hết. Offline
harness smoke 150 PASS, wrapper parse/UTF-8 PASS. Không đổi code/service/config.

SkipOperationalGuards và ContinueVerifiedAdmissions theo quyền đã có; không tạo
backup/global recovery gate hay RAM/CPU/health guard. Probe ngay trước chạy ghi
active scan/execution=0 và routes off; backend health UP, hai worker health probe
timeout ở lần đó. Giữ evidence timeout, không biến nó thành guard đã được miễn hoặc
kết luận worker DOWN khi service vẫn Running. Probe trước đó cả ba health UP.

Private seed/DPAPI cố ý giữ đến khi đối chiếu terminal Crawler/Control Plane hoàn
tất. Wrapper waiver chỉ ghi scoped API cleanup, không tuyên bố global recovery.
Automation đã ACTIVE, mỗi 15 phút chỉ thông báo thay đổi có ý nghĩa. Không phát lượt
thứ hai trong khi đang chạy; mục tiêu 1.000/index review vẫn chờ, Windows giữ bật.

#### Cập nhật admission và API lúc 06:36 UTC

150 attempts tạo scan: 146 HTTP 202, 4 timeout status 0/code 1050 sau khoảng
5.001–5.048 ms (indices 103, 104, 134, 145). Lỗi admission 4/150 = 2,6667%;
HTTP tổng giai đoạn submission, gồm 150 login và 150 admission, là 4/300 = 1,3333%.
Admission response-only p95 698,63 ms; elapsed từ client cho mọi attempt p95
3.192,55 ms, p99 5.046 ms. SLO elapsed và errors không đạt. Không dùng response-only
để che timeout hoặc coi 150 scans đã được nhận.

Reconciliation bốn attempt là UNRESOLVED/not_observed_not_proven_absent; không gửi
lại POST. Timing transport của bốn timeout đều zero, chưa xác định nguyên nhân.
Evidence: `150-scans/submission-observations.json`, `submission-summary.json`,
`admission-reconciliation.json` trong run directory. API 150 VU bắt đầu
06:29:58,475 UTC; chưa có `mixed-summary.json`, process k6 còn chạy ở lần kiểm.
146 tài khoản có scan ID; bốn tài khoản chưa có ID vẫn dùng dashboard/website/history,
không gọi route scan null. Chưa có kết quả cuối API/crawl hoặc terminal cleanup.

Đọc DB read-only lúc 06:37:38 UTC bằng bốn website IDs không tìm thấy scan ở
Control Plane hoặc execution ở Crawler tại thời điểm truy vấn. Giữ UNRESOLVED
cho đến đối chiếu cuối, không suy ra absent vĩnh viễn hoặc retry admission.
Proof: `150-scans/unresolved-db-live.json`. Hai mẫu telemetry active scope
06:36:44/06:37:13 đều ghi 146 RUNNING ở Control/Crawler; mẫu sau ghi 6.648
SUCCEEDED và 4.806 PERSISTING. Đây là số đang chạy, chưa phải tổng terminal hoặc
throughput toàn bài; global DEAD/orphan PERSISTING vẫn unknown.

#### API 150 VU đã kết thúc — kiểm lúc 06:44 UTC

`mixed-summary.json` hoàn tất 06:40:02 UTC, k6 PID37384 đã thoát. Tổng
27.867 requests (gồm 150 login), 3 lỗi = 0,010765%; rate 46,163 requests/s.
p95 1.030,47 ms, p99 1.677,43 ms, median 22,11 ms. Error/check SLO đạt;
latency p95<1.000 ms không đạt, stderr xác nhận threshold latency bị vượt.
`mixed-state.json` vẫn STARTED do harness ghi FINISHED sau crawl; không dùng
marker đó để phủ nhận summary và process exit.

Đối chiếu raw `mixed.jsonl`: cả ba lỗi ở `scan_pages`, HTTP404/code
SCAN_PAGE_NOT_FOUND, trong phút 13:30 local. 150 login không lỗi. Không có
HTTP timeout trong bài API này; chưa xác định nguyên nhân ba 404 và không gán
chúng cho ClickHouse connection timeout. Giữ toàn bộ login/startup errors.

Endpoint p95 ms: pages 1.692,09; login 1.051,79; dashboard 115,55; website list
105,59; scan list 93,04; progress 59,80. Danh sách trang là phần chậm nhất
trong bài này. API500 gần nhất p95 5.703,58 ms/errors 3,0023%; bài150 này
tốt hơn về số quan sát nhưng tải và khối lượng scan nhỏ hơn, chưa chứng minh
capacity500/1.000 hoặc hiệu quả riêng của từng patch. API chỉ chạy 10 phút.
Evidence: `150-scans/api-analysis.json`, `mixed-summary.json`, `mixed.jsonl`,
`mixed-stderr.txt`, `mixed-stdout.txt`.

Telemetry 06:43:33 UTC vẫn 146 RUNNING ở Control/Crawler, active-scope
13.453 SUCCEEDED/2.842 PERSISTING, 127.737 QUEUED; chưa có terminal mới.
`progress.jsonl` và `poll-failures.jsonl` còn 0 byte dù wrapper41140 còn sống;
chưa có sample polling hoàn chỉnh, không kết luận vòng polling hoạt động tốt.
Collector local38768/SSH26296 còn sống, remote telemetry tiếp tục tăng.
Proof live: `150-scans/telemetry-live-0644.json`. Chưa đủ evidence queue wait,
terminal event lag, cleanup hoặc global recovery. Giữ seed và workload đang chạy.

Kiểm lại 06:45 UTC: `progress.jsonl` đã có dữ liệu, sample mới nhất timestamp
06:44:39 UTC ghi 146 RUNNING, terminal0, processed14.112, unobserved0,
totalsComplete=true, scanPollingFailures rỗng; file failures vẫn 0 byte. Vì vậy
đã có evidence vòng polling trả sample, không còn chỉ dựa trên liveness wrapper.

### Kết thúc lượt 150 + 150 — đối chiếu cuối 03/10/2026, 08:40 UTC

Manifest gốc `FAILED_ACCEPTANCE_CRITERIA` lúc 08:31:08 UTC; wrapper gốc
`RECOVERY_UNVERIFIED` lúc 08:31:20 UTC. Không sửa hai outcome này thành PASS.
Các lý do benchmark: admission threshold, mixed API SLO, admission count mismatch
và bốn identity chưa resolved bởi harness. Wrapper line124 ném lỗi outcome;
line154 giữ recovery unverified vì cleanup-state gốc chưa xác minh bốn identity.
Không phải lỗi collector: telemetry đã thu hồi, wrapper/k6/local collector/SSH
collector đã thoát, không có lỗi mới trong stderr collector.

#### Kết quả và đối chiếu bổ sung

- Admission 146 HTTP202/150 attempts; bốn timeout giữ nguyên, không retry.
  Đọc sau terminal lúc 08:35:54 UTC không có scan/execution cho bốn website
  indices103/104/134/145. Đây là absence tại lần đọc cuối, không sửa HTTP thành công.
- 146/146 Control/Crawler COMPLETED, mỗi scan1.000 succeeded/0failed.
  Owner, website, terminal version và message khớp; latest outbox146 DELIVERED,
  latest inbox146 APPLIED. Không thấy mismatch; không backfill projection cũ.
- Analytics ClickHouse current có146.000 page rows và receipts tổng146.000 page
  metric rows, từng scan/owner đúng1.000. Workflow expected=published=146.000.
  Scoped queued/leased/persisting=0, pending/claimed/DEAD events/analytics=0.
- Thời gian Crawler first start06:29:57,935 → last finish08:29:06,703 UTC:
  7.148,768s =1h59m08,768s, **20,4231 pages/s** trên146.000 trang đã được nhận.
  Tổng yêu cầu150.000 trang còn thiếu4.000 do admission; không coi đủ bài150.
- Queue wait Crawler accepted→started median1,92s/p954,64s/max5,22s;
  Control created→started median16,76s/p9541,78s/max44,05s. Hai định nghĩa khác
  nhau; không gọi số Control là riêng thời gian Crawler chờ claim.
- Terminal lag Crawler finished→inbox processed median0,156s/p950,486s/max0,541s;
  finished→outbox delivered p950,497s/max0,568s. Không đại diện mọi progress event.
- API150 10 phút:27.867 request,3 HTTP404/SCAN_PAGE_NOT_FOUND=0,010765%,
  p951.030,47ms, pages p951.692,09ms; login150 không lỗi. K6 exit99 đã được harness
  lưu; error SLO đạt, latency không đạt. Bốn admission5s timeout vẫn chưa rõ nguyên nhân.

So với500 trước: crawler19,52pages/s →20,42pages/s, queue p956h32m48s →
Control41,78s, terminal event p9598,23min →0,486s; mismatch36/500 →0/146.
API p955.703,58ms/errors3,0023% →1.030,47ms/0,010765%. Mức tải và lượng trang
khác nhau, không đủ quy hiệu quả riêng cho patch hoặc công bố capacity500/1.000.

#### Cleanup và giới hạn evidence

Proof bổ sung xác minh routes/hosts off, route manager enabled=false/serviceRunning=true;
không còn remote test/collector process được kiểm và các PID local thuộc run đã thoát.
`final-analysis.json` xác minh scoped terminal cleanup, khác cleanup-state/wrapper gốc
còn unverified. Giữ nguyên artifacts gốc. Global DEAD/orphan PERSISTING ngoài scope
vẫn unknown, không tuyên bố global recovery sạch. 150 websites seed vẫn ACTIVE;
private seed/DPAPI giữ phục vụ kiểm tra owner/timeout, chưa archive/xóa tài khoản.

Truy vấn đối chiếu tổng hợp đầu đã timeout10s, lần thu hẹp vẫn timeout10s;
truy vấn tổng hợp30s lưu Control thành công nhưng phần Crawler timeout. Đã tách
executions/events/analytics, dùng latest-event lookup theo từng scan và đối chiếu
đạt dưới timeout30s. Lưu cả stderr thật, không quy diagnostic timeout thành lỗi API.

Evidence trong `tmp/load/phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z/`:
`final-analysis.json`, `terminal-db-proof-staged.jsonl`, `crawler-terminal-proof.jsonl`,
`closeout-proof.json`, `route-status-proof.json`, `local-process-exit-proof.json`,
`150-scans/level-manifest.json`, `scans.json`, `cleanup-scans.json`, `vps.jsonl`,
`api-analysis.json`. Runnable assert: `python tmp/load/analyze-runtime150-terminal.py` PASS.
Không deploy/thay config/restart/DDL hoặc phát tải khác. Mục tiêu1.000 còn mở,
phạm vi còn chờ; review indexrevision1 pending. Giữ Windows bật.

#### Chẩn đoán bốn admission timeout — 03/10/2026, 11:10 UTC

Đã đọc access logs Caddy hiện tại và ba archive gzip ngày03/10, đối chiếu đúng
146 website IDs đã nhận với146 POST admission trong cửa sổ06:29:40–06:30:15UTC.
Tất cả HTTP202/HTTP2, Caddy handler max502,83ms/median88,25ms. Không có POST
cho bốn website timeout trong các logs đã đọc; không có correlation IDs của bốn
request trong backend logs được giữ. Absence trong backend logs không chứng minh
request chưa vào backend vì admission timing logger chỉ DEBUG; probe logger
read-only trả401, không bật logging hoặc thay config.

Harness tạo150 VU gửi POST cùng lúc, timeout5s. Bốn request status0/code1050,
elapsed5.001–5.048ms, toàn bộ phase timing0. Trong k6v2.2.0, tracer chỉ tính
connect/TLS khi completion hook thành công và waiting sau wroteRequest; vì vậy
timing0 không có nghĩa không mất thời gian. Code1050 là request timeout chung,
không xác định riêng TCP/TLS. Kết hợp Caddy chỉ thấy146 POST và DB sau terminal
không có bốn scans, hướng nghi ngờ chính là connection acquisition/HTTPS trước
HTTP admission được quan sát. Chưa tách được DNS, TCP, TLS hoặc đường truyền;
không gọi đây là ClickHouse/backend timeout đã xác nhận.

146 response thành công vẫn có setup connection cost: blocked median1.120ms,
p95 xấp xỉ2,36s, TLS p95 xấp xỉ2,33s. Telemetry quanh burst ghi VPS CPU97,6%,
Tomcat busy9, Hikari pending0/timeout0; generator CPU mẫu gần đó21%. Samples
thưa không đủ loại trừ peak ngắn hoặc chứng minh CPU gây timeout. Connection
trace/packet evidence chưa được thu trong bài gốc. Không tăng timeout để đổi
kết quả, không retry POST hoặc phát workload mới.

Evidence: `admission-log-proof.json`, `admission-diagnosis.json` trong run directory;
helper `tmp/load/runtime150-admission-log-read.ps1` chỉ đọc, lọc bỏ headers/body/secret.
Nguồn diễn giải: [k6 error codes](https://grafana.com/docs/k6/latest/javascript-api/error-codes/),
[k6 v2.2.0 tracer](https://github.com/grafana/k6/blob/v2.2.0/lib/netext/httpext/tracer.go).

### Đánh giá giao lệnh HTTP/RabbitMQ — 2026-10-03

Người dùng đồng ý kế hoạch đánh giá broker. Scoped read-only command/inbox của
lượt 150 đối chiếu đủ 146 DELIVERED/APPLIED, mỗi command một delivery attempt;
Control outbox created→delivered p95 19,9695s. Chưa có claim-start trace để tách
outbox wait/HTTP/DB; bốn admission timeout vẫn là lỗi public HTTPS chưa rõ nguyên nhân.

Đã chạy công cụ transport cục bộ độc lập với RabbitMQ4.2.0, 27 mẫu, burst150/300/500,
inbox mô phỏng và delay20ms. Ở500 command, trung vị p95 ba lần: HTTP tuần tự22,098s,
HTTP4 sender5,549s, RabbitMQ4 consumer4,232s; không phải500 scan/API users.
Mandatory return, consumer-close redelivery, dedup/collision mô phỏng, dead-letter
và persistent message qua restart broker thật đã kiểm tra. Chưa có runtime adapter
hoặc benchmark handler/PostgreSQL thật; không thay production, deploy/DDL hay workload.

Proposal [ADR-017](../adr/ADR-017-rabbitmq-command-transport-evaluation.md) và
[báo cáo phương pháp](PERFORMANCE_DISPATCH_EVALUATION_2026-10-03.md) lưu điều kiện
đánh giá tiếp. Evidence mới `dispatch-db-proof.json`/`dispatch-analysis.json` cạnh
run150; `tmp/load/dispatch-evaluation-{results,summary}.json` là dữ liệu cục bộ.
