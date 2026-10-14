# Hồ sơ đánh giá độc lập lượt WebLens 500 scan

Ngày đối chiếu: 03/10/2026, khoảng 02:08–02:18 giờ local UTC+7.
Run: `worker64-500-after-claimfix`, run ID `20261002T095900Z`.
Các bảng ghi rõ UTC hoặc UTC+7; số thập phân trong JSON/CSV dùng dấu chấm.

## 1. Kết luận cần đọc trước

**Crawler hoàn thành đủ 500/500 execution, 500.000 trang succeeded và 500.000
analytics published. Control Plane chỉ hiển thị 464 COMPLETED và 36 CANCELLED.**
Đây là hai kết quả khác nhau của cùng 500 scan ID, không phải hai workload.

Đã đối chiếu version event cuối: đủ 500 event COMPLETED có trạng thái DELIVERED;
inbox Control Plane ghi 464 APPLIED và 36 IGNORED_STALE. 36 scan bị lệch có
remote_execution_version=0 trên Control Plane, mặc dù Crawler đã hoàn tất.
Event hoàn tất có độ trễ delivery p95 **98,23 phút**, max **100,26 phút**.

Kết luận trước “36 scan chưa được crawler chạy” cần sửa: 36 scan **chưa có
startedAt trong projection Control Plane**, nhưng đã chạy và hoàn tất ở Crawler.
Tốc độ 15,72 trang/s trước đây là tốc độ suy từ thời gian projection Control Plane;
tốc độ theo timestamps Crawler là **19,52 trang/s**, hoàn tất trong **7 giờ 6 phút 54 giây**.
Cả hai số đều là phép đo của fixture và cấu hình cụ thể, chưa phải capacity sản phẩm.

Toàn bài vẫn **không đạt**:

- API500: 64.850 request, 1.947 lỗi (**3,0023%**), p95 **5.703,58 ms**.
- Admission HTTP nhanh, nhưng client elapsed p95 **3.908,15 ms** không đạt SLO.
- Kết quả người dùng thấy sai trạng thái ở 36/500 scan, tương đương **7,2%**.
- Harness `FAILED` do chờ SSH collector quá hạn; level summary không được ghi.
- Wrapper `RECOVERY_UNVERIFIED`; global DEAD/orphan PERSISTING vẫn chưa đo.

Không sửa manifest gốc thành PASS. Không loại startup errors hoặc nới SLO.
Lần đánh giá này chỉ đọc evidence/DB có giới hạn và tạo hồ sơ; không sửa runtime,
restart, deploy, DDL hoặc phát workload mới.

## 2. Phạm vi và cách chạy

| Mục | Giá trị / ý nghĩa |
| --- | --- |
| Người dùng | 500 tài khoản riêng, 500 website riêng, 500 scan ID riêng |
| Admission | Mỗi VU tạo đúng một scan; setup login trước admission |
| Crawl | Mỗi scan giới hạn 1.000 trang; tổng yêu cầu 500.000 trang |
| Target | 500 hostname synthetic riêng, chung fixture xác định; không phải 500 website thật |
| Fixture | 1.000 trang, fanout10, delay2ms, body4.096 bytes, entry page0 |
| Worker toàn service | 64; giới hạn mỗi hostname2 và delay1 giây |
| Config từng scan | concurrency20, maxDepth4, maxResponseBytes10MiB, maxRedirects5, maxDurationSeconds86.400 |
| Hạn quan sát của harness | 28.800 giây / 8 giờ; khác maxDurationSeconds của scan |
| Mixed API | constant-vus500 trong 10 phút; login đầu VU stagger0–14,5 giây |
| API đọc | dashboard, websites, scans, progress, pages?limit=20, luân phiên |
| Pacing | Sau một lượt API sleep3s; login lỗi sleep3s rồi thử lại |
| Timeout | Admission5s; mixed login/read10s |
| Mô hình tải | Closed model: request rate giảm khi latency tăng; 500 VU không đồng nghĩa 500 request/s |
| Capture / trình duyệt | Không phát bài tải Capture/AI/UI/browser riêng trong lượt này |

API500 chỉ chạy 10 phút lúc đầu crawl. **Chưa đo 500 người dùng tương tác API
liên tục suốt 8 giờ**, cũng chưa đo 1.000 người. 500 VU có 600 mẫu ghi vus=500;
7 mẫu cuối giảm VU trong thời gian kết thúc. Đầu lượt không phải mọi VU đều đã
đăng nhập thành công. Cả 500 cuối cùng có login HTTP200 trong cửa sổ này.

Quyền người dùng: dự án cá nhân, chấp nhận mất dữ liệu; không cần backup,
global recovery gate hoặc guard RAM/CPU/health để chạy tải. Vẫn giữ authentication,
HTTP errors, timeout, SLO, ownership, identity reconciliation và cleanup.
Review index revision1 còn pending; việc này không phải phê duyệt schema/index.

## 3. Môi trường và provenance

- VPS Windows Server2019 Datacenter build17763; 8 logical CPU, Xeon Gold6133
  2,50GHz theo CIM; RAM khả dụng cho OS khoảng7,00GiB.
- PostgreSQL17.11 trên VPS. Collector quan sát Control Plane, Crawler và Capture
  database. Không bật pg_stat_statements; không có query-level workload statistics.
- JVM/Tomcat: max thread 100; Hikari max 32 theo telemetry effective, không dùng
  con số10 của tài liệu môi trường cũ để diễn giải lượt này.
- Crawler clickhouse-go v2.43.0: MaxOpenConns10, MaxIdleConns5, DialTimeout5s,
  ConnMaxLifetime30m. Report reads, analytics writer và readiness dùng cùng sink.
- Các browser ngoài WebLens tồn tại trên VPS: thường8, max10; 1 mẫu có browser
  chưa xác định path. WebLens browser count0 trong toàn bộ mẫu. Tài nguyên host
  gồm cả các process này; không quy toàn bộ CPU/RAM/disk cho workload test.

| Artifact | SHA-256 / commit |
| --- | --- |
| Release base | `9e87e8b0c95ea1791dcc4814793e45b1e391ca36` |
| Crawler diagnostic commit | `b1d1f88dbbbf30ef3ad0ffae56504c7c221d7cd5` |
| Crawler claim fix commit | `ceb3a767b36d91a65725f8791839eb7fceb9727f` |
| Crawler binary | `586a1b84926579748f9dfa97e37761aee274328ed600cb44afa1a81b9e165717` |
| Backend binary | `924db7d2cf9930cb32cde21c3d503846ee6c04cbeecaad8ae3222ed05c8d8326` |
| Collector | `dce12b3af62d3bcc44fe0a9f9aa8abbbc6d6f3765e513bedd9982bbc95fc786d` |
| Harness | `e126e1105f8c901f195dfca2cd1aa78678da5aded589d96ac5ef5586c495b356` |

Binary hashes đọc lại sau lượt vẫn khớp. Manifest crawlerPatchCommit=null dù
binary khớp patch đã lưu; cần dùng nguồn provenance bổ sung và hash, không suy
ra toàn bộ source chỉ từ releaseCommit của manifest. Checkout chính có nhiều
thay đổi chưa commit; không coi checkout chính là source runtime đã deploy.

Kiểm thử trước deploy đã lưu: go test ./... passed; 8 workflow integration branches
trên PostgreSQL18 local riêng passed; patch-manager/harness/k6 smoke passed.
Race test unavailable do CGO disabled. Đây là kiểm thử trước lượt, không phải
rerun trong lần audit; PostgreSQL18 local khác PostgreSQL17 production.

## 4. Timeline

| UTC ngày 02/10 | Giờ local UTC+7 | Sự kiện |
| --- | --- | --- |
| 09:58:52 | 16:58:52 ngày02/10 | Wrapper 30516 bắt đầu |
| 10:02:46 | 17:02:46 | Collector bắt đầu có mẫu |
| Khoảng10:10 | Khoảng17:10 | 500 admission HTTP202 đã đối chiếu |
| 10:10:05,813 | 17:10:05,813 | Crawler first startedAt |
| 10:10:13 | 17:10:13 | API500 bắt đầu |
| 10:20:17 | 17:20:17 | Request metric cuối API; k6 kết thúc exit99 |
| 17:17:00,041 | 00:17:00 ngày03/10 | Crawler execution cuối hoàn tất |
| 18:10:07 | 01:10:07 | Poll Control Plane:452 COMPLETED,48 chưa terminal,456.858processed |
| Khoảng18:10:13 | Khoảng01:10:13 | Hạn8h; harness gửi cancellation cho phần chưa terminal trên Control Plane |
| 18:22:10 | 01:22:10 | finishedAt cuối của projection Control Plane |
| 18:25:10 | 01:25:10 | Harness exception khi chờ SSH collector; cleanup-scans cuối đủ 500 |
| 18:26:24 | 01:26:24 | Wrapper RECOVERY_UNVERIFIED rồi thoát |
| 18:53–18:54 | 01:53–01:54 | Xác minh remote collector thoát, routesoff; dọn local SSH collector còn sót |
| 19:08–19:12 | 02:08–02:12 | Đối chiếu500 execution,500 projection,500 latest outbox/inbox records |

Timestamp của sample là lúc bắt đầu thu thập tuần tự. Timestamp request metric
là lúc hoàn tất request. Timestamp projection Control Plane dùng clock lúc apply
event; không phải startedAt/finishedAt vật lý của Crawler.

## 5. Admission

500/500 HTTP202,500 scan ID riêng; không có unresolved admission identity.
Đã assert từng index/accountIndex/scanId và tập ID với cleanup cuối.

| Chỉ số client | Median ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: |
| HTTP duration | 44,43 | 99,55 | 311,72 |
| Tổng elapsed | 2.739,00 | 3.908,15 | 4.219,00 |
| Blocked | 2.703,25 | 3.852,71 | 4.160,71 |
| Connecting | 200,84 | 432,48 | 3.049,13 |
| TLS handshake | 2.493,67 | 3.660,82 | 3.887,77 |
| Waiting | 41,99 | 98,25 | 304,65 |

HTTP p99=200,93ms, đạt ngưỡng2s; elapsed p99=4.059,51ms, không đạt.
SLO admission giữ p95<1.000ms,p99<2.000ms cho cả HTTP và elapsed; lỗi<1%.
K6 admission threshold failure không biến mất vì 500 admission thành công.
Blocked gồm các bước kết nối chồng nhau; **không cộng các percentile**.
Chưa chứng minh TLS chậm do client, network hay Caddy.

## 6. API500

| Endpoint | Request | Lỗi HTTP | Mean ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| auth_login | 1.452 | 952 | 7.247,91 | 10.000,52 |
| dashboard_summary | 12.759 | 34 | 615,52 | 1.985,26 |
| website_list | 12.681 | 153 | 610,13 | 1.335,91 |
| scan_list | 12.644 | 189 | 629,03 | 1.351,02 |
| scan_progress | 12.639 | 198 | 689,98 | 1.602,99 |
| scan_pages | 12.675 | 421 | 4.723,00 | 6.772,28 |
| Tổng | 64.850 | 1.947 | 1.582,92 | 5.703,58 |

Median tổng505,94ms,p99=10.000,34ms; k6 reported106,84request/s.
SLO error rate<1%,p95<1.000ms,checks>99% đều không đạt.
checks62903passed/1947failed; weblens_api_errors995 chỉ đếm nhánh activity đọc,
**không gồm952 login failures**. Các boolean threshold trong exported k6 summary
đánh dấu failure; phải đối chiếu số đo và exit99, không đọc true như PASS.

Login:500HTTP200,876HTTP0,76HTTP502. Nhánh đọc có995 lỗi; custom error codes:
792HTTP_0,202SCAN_PAGE_NOT_FOUND,1CRAWLER_REPORT_UNAVAILABLE.
Raw status của scan_pages:219HTTP0,201HTTP404,1HTTP503,12254HTTP200.
Custom code và raw HTTP status lệch một trường hợp trong nhóm page errors;
không ép chúng thành ánh xạ1:1 khi chưa có request-level correlation.
HTTP0 là thất bại transport/client, không phải response thành công latency0.

### Phân tích theo thời gian, giữ nguyên outcome cả lượt

| Phút theo metric completion | Request | Lỗi |
| --- | ---: | ---: |
| 0 | 2.209 | 1.398 |
| 1 | 6.213 | 549 |
| 2–9 | 56.180 | 0 |
| Tail phút10 | 248 | 0 |

Tất cả1.947lỗi nằm trong hai phút đầu. Sau cutoff10:12:13UTC có56.428request,
0lỗi, nhưng p95 tổng vẫn4.802,20ms; scan_pages p95=5.658,81ms,mean4.611,21ms.
Các API đọc khác sau cutoff vẫn có p95 khoảng1.020–1.082ms.
Đây là phân tích sau lượt để tách startup/login surge với report latency;
không bỏ hai phút đầu, không đổi SLO. Request trong bucket có thể bắt đầu trước cutoff.

### Bằng chứng server và giới hạn

- 52 log acquire connection timeout ClickHouse:48page-report,4summary-report.
- Pool10 dùng chung read/write/readiness đã xác nhận từ source đúng patch.
- Mean từ stage counter quanh API: report.remote4.119,93ms,
  report.authorization5,73ms; password1.752,80ms,session566,78ms,lookup171,39ms.
  Đây là mean, không phải p95; cửa sổ counter bao10:10:10–10:20:22UTC và có thể
  chứa observer/traffic khác, request server hoàn tất sau client timeout.
- Sampler bổ sung41 mẫu: Tomcat busy median/p95/max100. Mẫu tuần tự mất
  median8,14s,max72,36s; không coi mẫu là snapshot đồng thời.
- ClickHouse system.processes bị497ACCESS_DENIED; chưa có query-level latency,
  thời gian giữ connection hoặc Stats của pool trong runtime này.
- Driver đóng/release rows khi Next hết dữ liệu. Chưa có bằng chứng leak do
  defer rows.Close trong ListPages; không khẳng định tăng pool một mình sẽ đủ.
- 202not-found chưa có giải thích request-level; không tự chuyển404 thành200.
- Không giảm BCrypt strength12 hoặc tắt authentication để cải thiện số đo.

## 7. Crawl và tính nhất quán giữa service

| Nguồn đúng 500 scanID | COMPLETED | CANCELLED | Succeeded | Published |
| --- | ---: | ---: | ---: | ---: |
| Crawler PostgreSQL | 500 | 0 | 500.000 | 500.000 |
| Control Plane PostgreSQL | 464 | 36 | 464.000 | 464.000 |
| Cleanup API evidence | 464 | 36 | 464.000 | Không dùng làm bằng chứng analytics độc lập |

500 execution Crawler đều có expected=published=1.000,succeeded1.000,failed0.
Counter published là trạng thái durable của Crawler; **chưa độc lập query physical
ClickHouse rows theo owner/scan cho đủ 500**, cũng chưa kiểm chất lượng toàn bộ HTML,
links/findings/SEO/content. Không diễn giải “0 trang lỗi” thành “không có lỗi hệ thống”.

| Khoảng thời gian | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| Queue thực ở Crawler, đủ 500 | 11.548,59s /192,48phút | 23.568,34s /392,81phút | 24.870,37s /414,51phút |
| Execution thực ở Crawler, đủ 500 | 627,04s /10,45phút | 795,19s /13,25phút | 1.531,76s /25,53phút |
| Gửi event hoàn tất, đủ 500 | 3.942,95s /65,72phút | 5.893,59s /98,23phút | 6.015,51s /100,26phút |
| “Queue” từ startedAt Control Plane, chỉ 464 | 14.352,39s | 27.385,65s | 28.817,91s |

Queue thực vẫn dài, nhưng queue suy từ Control Plane còn gồm độ trễ event.
500 scan không thực sự fetch đồng thời: poll projection max RUNNING24; engine
peakActive median2,p953,max21 dù global worker64. Những mẫu này không tự chứng
minh giới hạn host hay số worker là nguyên nhân chính.

### Chuỗi sai lệch đã có bằng chứng

1. Crawler hoàn tất tất cả trước17:17UTC, gần53phút trước deadline harness.
2. 36 projection Control Plane vẫn QUEUED/version0 tại lúc timeout; cancellation
   trên QUEUED chuyển ngay projection sang CANCELLED, dù execution remote đã xong.
3. Source ScanEntity dùng clock lúc apply event để ghi startedAt/finishedAt,
   không dùng timestamps thực của Crawler.
4. applyRemoteProjection trảfalse nếu projection local đã terminal. Version
   COMPLETED cuối của36 scan vẫn 3001, inbox nhận đủ nhưng ghiIGNORED_STALE.
5. Đủ500 latest event version khớp final Crawler progress_version, đã DELIVERED;
   đủ 500 latest inbox version khớp, chỉ 464 APPLIED. Việc gửi HTTP2xx không chứng minh
   projection được áp dụng đúng.

Đã chứng minh event delivery chậm và terminal cancellation chặn cập nhật muộn.
Publisher hiện claim25 rồi gửi tuần tự; đây là candidate bottleneck cần đo
generation rate/delivery rate, HTTP/DB acknowledgement và retry/lease trước tối ưu.
Chưa chứng minh riêng vòng gửi tuần tự là toàn bộ nguyên nhân98phút trễ.
Latest events đã kiểm; không coi đây là audit mọi event cũ hoặc global backlog.

## 8. Engine và analytics logs của toàn lượt

Log Crawler current+rotated+snapshot API được hợp nhất và dedup JSON record,
lọc đúng09:58:52–18:26:24UTC. Không cộng lặp snapshot với rotated file.
1.015interval engine ghi tổng500.000claimed/fetch/build/commit; stage errors0.
Claim count520.609 bao cả empty attempts; không đồng nghĩa520.609 trang.

| Stage engine | Weighted mean ms / invocation |
| --- | ---: |
| Claim gồm empty attempts | 48,56 |
| Fetch | 6,31 |
| Build | 0,30 |
| Commit | 22,97 |

Không cộng mean này thành latency request; các stage có count và concurrency khác.
Không có interval backpressured được log trong cửa sổ; không chứng minh absence
của mọi dạng backpressure. Bản fix ClaimPage chọn/lockLIMIT1 trước correlation
enrichment; đã loại expensive repeated inbox lookup, nhưng chưa giải quyết
event lag, fairness hay report API.

8.800analytics batch timing records: medianbatch57, p9572,max100;
acknowledged tổng500.000. Batch total median2.823ms,p953.529,05ms,max44.865ms;
writeBatch median1.925ms,p952.021,05ms; acknowledgement median862ms,p951.467,10ms;
receipt lookup median210ms,p95226ms. Đây là timing của batch, không phải latency
một trang hoặc API. Các receipt/insert steps có overhead đáng điều tra.

Lỗi ngoài HTTP vẫn phải giữ:

- 149 analytics acknowledgement lease stale;17 event acknowledgement lease stale.
- 3 event delivery timeout trên toàn run;2 scan command rejection do timeout/cancel.
- Report errors: pool acquire52, page query deadline6, summary canceled9,
  page query canceled9, findings canceled1, page iteration canceled1.
- Backend có3 warning connection closed của Hikari và2 command delivery warning.
- Caddy trong API window có132 error log:69 idle connection closed,59 EOF,
  3 aborted connection,1 dial timeout; cả run thêm2 root certificate install error
  trong thao tác cấu hình routes. Số log không ánh xạ1:1 với request k6.
- Poll Control Plane có2 timeout ngày17:10:44/17:10:54local, được giữ trong kết quả.

Lease stale không tự chứng minh mất dữ liệu. Đối chiếu hiện tại cho thấy500 execution
đã hoàn tất và analytics counter đủ; nguyên nhân lease timeout cụ thể chưa phân tách.

## 9. Tài nguyên, DB và chất lượng telemetry

| Chỉ số VPS | Toàn cửa sổ collector: median / p95 / max | API window: median / p95 / max |
| --- | --- | --- |
| CPU host | 49,00% /59,72% /85,50% | 60,40% /66,40% /69,10% |
| RAM sử dụng | 74,77% /78,52% /84,18% | 81,55% /82,27% /82,94% |
| Tomcat busy threads | 2 /3 /100 | 100 /100 /100 |
| Hikari pending | 0 /0 /0 | 0 /0 /0 |
| Hikari active | 0 /1 /3 | 0 /2 /2 |
| Disk queue length | 0 /10 /21 | 0 /0,10 /1 |

- Collector VPS1.769 mẫu,10:02:46–18:22:07UTC; API window19 mẫu.
  Sample gap median16,76s,p9517,42s,max87,79s; khai báointerval5s nhưng sampling
  tuần tự có overhead. API sample gap median28,12s,max35,43s.
- Generator3.831 mẫu; gap median7,70s,max12,51s. API69 mẫu CPUmedian4%,p959%,max20%.
  Toàn cửa sổ generatorCPUmax100% có thể gồm hoạt động khác/setup; không chứng
  minh generator bão hòa trong API hoặc nguồn TLS delay.
- JVM memory.used max445.440.640bytes; gồm nhiều memory pools, không gọi đây là
  heap riêng. GC pause counter delta1.883 events/20,631s trên toàn cửa sổ;
  không có per-pause p95 từ nguồn này. process.cpu.usage/system.cpu.usage=-1
  trong cả1.769 mẫu, bị loại khỏi CPU statistics, không coi là CPU0.
- Hikari timeout counter delta0; PostgreSQLdeadlock delta0 ở cả3database.
  Mẫu lockWaiting max1 ởControl/Crawler,max2 ởCapture; khoảng giữa mẫu vẫn có
  thể có contention. pg_stat_* counters là toàn DB, không chỉ workload500.
- Disk free minimum23.293.267.968bytes /21,69GiB. Disk readmax~202,24MiB/s,
  writemax~65,31MiB/s. PerfDisk `_Total` percentTime p95 628,6/max 1870 không
  phải phần trăm utilization bounded0–100; không dùng riêng số này để kết luận
  disk saturation. Chưa có disk latency/fsync latency/query IO attribution.
- Network counters là tổng host interface; không đo RTT/TLS server CPU hoặc
  attribution riêngfixture/ClickHouse/API. Chi tiết TCP/network trong telemetry
  gốc không biến thành bằng chứng bottleneck khi chưa đối chiếu request.
- Service status6 service đềuRunning trong1.769 mẫu. Progress health962 mẫu:
  Backend200:962,Capture200:962,Crawler200:955 và503:7. Sampling khác nhau;
  không dùng statusRunning hoặc available telemetry làm chứng minh continuous UP.
- Capture/object storage không được benchmark trong lượt này. Các count capture
  historical tồn tại không phải workload mới của bài500.

## 10. Harness, kết quả và cleanup

Manifest outcome=FAILED, levels=[] vì exception dòng 1013 chờ SSH collector 180s;
không có level-manifest. API mixed-state đã FINISHED, exit99.
File scans.json trước cleanup có 498 terminal; cleanup-scans.json có 500 terminal,
bổ sung 2 COMPLETED. Tổng kết tự động từng xuất request0/trường trống/routes off False
do thiếu summary/proof đã được sửa trong hai báo cáo; không sửa artifact gốc.

Collector stderr: 6.376.954 bytes, 22.748 PowerShell CLIXML progress records,
không có S=error/warning record, XML cuối không đóng đầy đủ. Đây là dấu hiệu
để điều tra serialization/SSH stream/backpressure; **chưa chứng minh quan hệ nhân quả**.
Toàn bộ JSONL telemetry đã thu hồi có 0 JSON parse failures. Collector chậm, timestamps
không đồng thời và thiếu automatic level summary là hạn chế của bộ đo.

Run terminal verified và 500 ID đã đối chiếu. Private seed/DPAPI được harness xóa.
Remote collector PID10256, wrapper30516 đã thoát; SSH collector PID35880 còn sót được
xác minh parent30516/encoded command đúng run rồi dừng riêng sau remote exit.
Hai marker Caddy xác nhận routes test off đã lưu proof; không can thiệp task khác.
Không tuyên bố global recovery sạch: global DEAD và orphan PERSISTING vẫn unknown.
500 terminal event cuối đã DELIVERED không chứng minh mọi event cũ đã được xử lý hết.
Automation PAUSED. Không shutdown; mục tiêu 1.000 còn mở.

## 11. So sánh có giới hạn

| Bài | Crawl / projection | API |
| --- | --- | --- |
| 500 cũ after-timing-retry | Control Plane: 81 COMPLETED/419 CANCELLED, 83.671 processed; chưa audit lại Crawler của bài cũ theo cách này | 3,8104% lỗi, p95 6.275,94 ms |
| 25 sau claim fix | 25 COMPLETED, 25.000 succeeded, 16,55 pages/s; formal FAILED chỉ vì resource gate cũ | 0% lỗi, p95 662,14 ms |
| 500 hiện tại | Crawler: 500 COMPLETED/500.000 succeeded/19,52 pages/s; Control Plane: 464 COMPLETED/36 CANCELLED | 3,0023% lỗi, p95 5.703,58 ms |

Không so 81 projection của bài cũ với 500 execution hiện tại để công bố phần trăm
tăng crawler capacity. Cấu hình/trace của bài cũ cần đối chiếu tương tự nếu muốn
before/after đúng nguồn. Bài 25 không chứng minh bài 500 hoặc 1.000 sẽ đạt.

## 12. Vấn đề cần đánh giá và phép đo tiếp theo

| Vấn đề | Mức bằng chứng | Việc còn thiếu |
| --- | --- | --- |
| 36 local CANCELLED nhưng remote COMPLETED | Đã đối chiếu 500 ID, version, outbox, inbox và source terminal guard | Thiết kế cancellation/reconciliation đúng ownership, version và race; không sửa dữ liệu trong audit |
| Terminal event trễ 8–100 phút | Đã đo 500 event created→delivered | Generation/delivery rate, oldest pending trong scope, timing HTTP/ack DB; publisher gửi tuần tự là candidate |
| Pool ClickHouse timeout/report chậm | 52 timeout, shared pool10, remote mean4,12s | Timing query/pool, read/write isolation có đối chứng; chưa chứng minh tăng pool là đủ |
| Startup/login burst | 952 login errors; Tomcat100 busy; password mean1,75s | Queue/thread/CPU cho login và TLS/502 correlation; giữ BCrypt/auth security |
| Admission elapsed chậm | HTTP p95 0,10s nhưng elapsed p95 3,91s | Generator/network/Caddy TLS attribution; không cộng percentile |
| 202 SCAN_PAGE_NOT_FOUND | Counter thật, 201 raw404 và một trường hợp metric lệch | Timeline request ID→owner/scan/command consumption; không mask404 |
| Queue thực Crawler dài | p95 392,81 phút theo 500 execution | Dispatch/fairness và phân phối slot; không tăng worker khi chưa đo |
| Collector SSH không thoát | Exception/progress stderr/exit proof | Stream handling, timeout, cancellation của collector; không làm mất primary failure |
| Analytics physical correctness | Durable expected=published=500.000 | Physical ClickHouse dedup/counts/quality theo owner/scan chưa query độc lập |

Phương án đã chuẩn bị trước audit cho API: tránh query ClickHouse khi report có
expected=published=0 sau ownership/filter/cursor validation; thêm timing query/pool,
giữ FINAL/dedup/freshness/lỗi thật. Đây là candidate chưa deploy/chưa benchmark;
nó không sửa 36 projection sai hoặc nhánh report có dữ liệu.

Đề nghị đánh giá ưu tiên tính nhất quán/cancellation/event lag cùng API bottleneck,
rồi thiết kế bài nhỏ có đối chứng, sau đó retry500. Không suy ra capacity1.000 từ
ngoại suy tuyến tính. Phạm vi 1.000 còn chưa rõ: mỗi account scan1.000 trang hay API
trên dữ liệu có sẵn; không tự khởi chạy1.000. Không bổ sung infrastructure/schema theo suy đoán.

## 13. Dữ liệu kèm và kiểm tra tái lập

Gói ZIP chứa:

1. Hồ sơ Markdown này.
2. metrics.json: metrics toàn lượt, API theo endpoint/phút, telemetry và đối chiếu.
3. cross-service-reconciliation.csv: đủ 500 scan đã ẩn danh, queue/execution thực
   Crawler, trạng thái Control Plane, version, event delivery delay và inbox outcome.
4. scans-anonymized.csv: 500 projection cleanup gốc để so với Crawler, không UUID/email.
5. source-excerpts.md: code cancellation/terminal guard/event service/publisher/shared pool.
6. source-hashes.json: SHA-256 nguồn raw để truy ngược; không kèm raw có identity.

Raw nằm ở run directory `tmp/load/phase8-worker64-500-after-claimfix-500x1000-20261002T095900Z/`
và `tmp/load/diagnosis-500-20261002/full-run-audit/`. Không chia sẻ seed,
password, token, email, env hoặc credential artifact. Raw UUID dùng chỉ để join nội bộ;
CSV chia sẻ dùng ordinal1–500, đối chiếu hai file bằng ordinal.

Audit script offline: `tmp/load/diagnosis-500-20261002/full-run-audit/audit.py`.
Assertions: đủ 500 identity/account, admission202, CP terminal, tổng trang,
64.850 request/1.947 errors khớp k6, JSONL parse failures0, đúng500 ID giữa hai
DB/outbox/inbox, 36 mismatch, 500 final version khớp, 500 analytics counts đủ,
464 APPLIED/36 IGNORED_STALE.
Các DB read dùng statement timeout2s, lock timeout500ms, read-only, 50 ID/batch,
index theo ID hoặc aggregate/type/version; 40 batch thực thi136–458 ms theo nguồn.
Không scan global DEAD/orphan PERSISTING hoặc DDL. Kiểm tra đầu vào ID trên
PowerShell5 ban đầu nhận array lồng, đã sửa unwrap trước khi bất kỳ DB query nào chạy.

## 14. Yêu cầu gửi ChatGPT đánh giá lại

Hãy đọc toàn bộ hồ sơ và dữ liệu kèm, đánh giá độc lập, phản biện các kết luận
của người lập báo cáo. Đừng chỉ lặp lại hướng tối ưu đã đề xuất.

1. Phân biệt acceptance của API, worker throughput, trạng thái người dùng thấy,
   consistency, analytics correctness và chất lượng bộ đo. Chỉ ra phần đạt/chưa đạt.
2. Kiểm tra chuỗi 500 Crawler COMPLETED nhưng 36 Control CANCELLED; đánh giá cancellation,
   event ordering/version/idempotency/terminal guards. Điều gì đã chứng minh,
   điều gì còn là giả thuyết? Cách sửa nhỏ nhất cần giữ những invariant nào?
3. Phân tích event delivery lag tới100 phút, shared ClickHouse pool timeout, login burst,
   Tomcat saturation, admission TLS delay, lease stale và report not-found. Xếp ưu tiên
   theo bằng chứng; không khẳng định tăng pool/worker hoặc thêm index sẽ giải quyết.
4. Kiểm tra bias của fixture, closed VU model, pacing, 10 phút API, post-hoc cutoff,
   timestamp projection, telemetry tuần tự, disk PercentTime và collector failure.
5. Đề xuất phép đo nhỏ tiếp theo có workload/duration/SLO/counter/cleanup proof
   cụ thể; chỉ đổi một yếu tố để tách nguyên nhân. Giữ startup failures và lỗi thật.
6. Nêu dữ liệu còn thiếu trước khi chọn bài 1.000 người hoạt động liên tục.
   Không suy capacity thật từ synthetic fixture hoặc 500 VU10 phút.
7. Người dùng đã bỏ backup/global recovery gate/resource guards cho đo tải; không
   yêu cầu lại các cổng đó. Giữ authentication/ownership/data-consistency,
   errors/timeouts/SLO, identity reconciliation và cleanup. Review DDL/index pending.

Trả lời bằng tiếng Việt: kết luận ngắn, bảng nguyên nhân/bằng chứng/độ chắc chắn,
ưu tiên sửa, rủi ro concurrency và kế hoạch xác minh có thể chạy được. Nếu số
liệu mâu thuẫn, chỉ rõ file/field và đề xuất đối chiếu, không tự chọn số đẹp hơn.
