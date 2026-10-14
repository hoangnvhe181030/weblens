# Tối ưu report, crawl dispatcher và event — 2026-10-03

## Phạm vi và trạng thái

Người dùng đã yêu cầu sửa cả ba luồng sau kế hoạch tối ưu. Thay đổi nằm tại local,
đã kiểm thử; chưa deploy, chưa chạy lại tải production hoặc thao tác cloud.
Không có dependency, schema, migration hoặc index mới. Các thay đổi có sẵn trong
dirty checkout được giữ lại; không dùng binary từ checkout này để deploy trực tiếp.

Baseline là lượt `worker64-500-after-claimfix`, ID `20261002T095900Z`:
crawler 500 COMPLETED/500.000 succeeded, 19,52 trang/s; API 3,0023% lỗi, p95
5.703,58 ms; pages p95 6.772,28 ms; event terminal delivery p95 98,23 phút;
queue p95 6 giờ 32 phút 48 giây. Các số này vẫn là kết quả trước tối ưu.
Xem [audit lượt 500](WEBLENS_500_SCAN_REVIEW_2026-10-03.md).

## Report API

- `crawler/internal/httpapi/server.go`: sau owner/state, filter và cursor validation,
  nếu workflow Crawler có analytics expected = published = 0 thì trả items `[]`,
  summary 0, không có next cursor. Không shortcut bằng status/counter Control Plane.
  Expected > 0 nhưng chưa published vẫn truy vấn ClickHouse vì ingest có thể đã
  thành công trước acknowledgement. Missing scan vẫn 404; unavailable vẫn 503.
- `crawler/internal/analytics/clickhouse.go` và `reports.go`: tách pool đọc 7/ghi 3
  trong tổng budget 10 hiện có. Readiness kiểm tra cả hai; startup failure và Close
  đóng cả pool. Writer/receipt tiếp tục dùng pool ghi; mọi report dùng pool đọc.
- Admission cho mỗi truy vấn đọc có tối đa 7 slot, chờ theo request context, trả
  slot sau khi đóng rows và trước truy vấn findings tiếp theo. Không giữ slot qua
  nested query. Không đổi SQL, owner scope, current-view dedup, watermark hay filter.
- Timing `admission_wait_ms` đo chờ slot tại application; `query_and_read_ms` gồm
  native acquire/dial, network, query và đọc kết quả. Đây không phải timing query
  server thuần túy. Log chậm từ 250 ms, timeout và pool stats; không log token/SQL
  parameters/body. Chưa có timing riêng native acquire so với server execution.

## Event lag

- `crawler/internal/postgres/store.go`: giảm snapshot progress cùng trạng thái xuống
  tối đa một event/giây/scan. Kiểm tra snapshot cuối trong cùng transaction giữ lock
  execution; không thay payload/message ID của event đã ghi, không xóa lịch sử.
  Snapshot đổi trạng thái, CANCEL_REQUESTED và terminal được ghi ngay. Counters và
  progress version trong workflow vẫn cập nhật đầy đủ, terminal mang snapshot cuối.
- Đây là lấy mẫu progress, không bảo đảm callback đúng mỗi giây: khi không có hoạt
  động, không tạo timer event; khi delivery lỗi, retry/lease vẫn có thể gây trễ.
- Claim lấy version pending đầu tiên của từng scan và không lấy tiếp khi scan đó
  có event CLAIMED. Event đang retry chặn version sau cho đến khi được xử lý hoặc
  DEAD; DEAD vẫn là lỗi cần đối chiếu, không được coi là applied.
- `crawler/internal/events/publisher.go`: tối đa 4 event/scan độc lập gửi song song,
  lấy batch kế tiếp ngay khi có việc, chỉ poll chậm khi rỗng/lỗi claim. Lease owner
  mới mỗi batch; request có deadline trong lease và HTTP timeout cũ 10 giây.
- Chỉ accepted=true và outcome APPLIED/IGNORED_STALE mới được acknowledge. HTTP 2xx
  thiếu body hợp lệ vẫn retry. IGNORED_STALE được tiêu thụ hợp lệ nhưng không coi
  là APPLIED. CompleteEvent kiểm tra cả lease owner và thời hạn.
- Log batch gồm count, scan_count, duration_ms, oldest_claimed_age_ms, applied,
  ignored_stale, acknowledged. Age của batch đã claim không phải tuổi toàn backlog.
  Outbox và inbox terminal vẫn cần đối chiếu riêng trong mỗi lượt đo.

## Điều phối crawl

- `crawler/internal/crawl/engine.go`: tối đa 4 claim song song, không theo số lượng
  worker fetch. Slot đang claim và fetch cùng dùng trần worker hiện có. Khi không
  có việc, mỗi vòng tối đa 4 claim rồi chờ poll; shutdown chờ claim và fetch kết thúc.
- `store.go`: trong các execution đủ điều kiện, ưu tiên leased_count thấp, rồi
  updated_at, accepted_at và id. Scan nhận hoạt động gần đây nhường cơ hội cho scan
  khác. Không dành ưu tiên vô điều kiện cho mọi scan mới, không thêm timestamp/index.
- updated_at cũng đổi do commit/analytics, nên đây là fairness theo hoạt động, không
  phải round-robin chính xác. Sort/eligibility query cần benchmark với frontier lớn.
- Host concurrency/delay, execution concurrency, deadlines, backpressure, SSRF,
  lease generation và transaction lock order tiếp tục được cưỡng chế. Không giữ
  transaction khi fetch HTTP. Không tăng cấu hình worker/host/rate production.
- Log mỗi khoảng 10 giây: claims, claimed_pages, empty_claims, claim_mean_ms,
  occupied_slots, fetch_limit. Occupied gồm slot đang claim, không chỉ fetch active.

## Kiểm thử đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| `go test ./...` | PASS; integration cần env được skip trong lệnh này |
| PostgreSQL `TestStoreWorkflowIntegration` | 14 subtest PASS trên cluster test 18.4 loopback |
| `go vet ./...` | PASS |
| `go build ./cmd/weblens-crawler` | PASS |
| Java ScanCancellationIT, ScanEventServiceTest, ScanEntityTest, ScanStateMachineTest | 16 PASS, gồm 5 integration; 0 failure/error/skipped |

Kiểm tra mới bao gồm: progress bị giới hạn nhưng giữ đổi trạng thái/terminal;
scan chờ được nhận việc; một claim event/scan; lease hết hạn và owner cũ không
acknowledge được; gửi song song/đúng thứ tự, ack hỏng, HTTP timeout; fetch/claim
bounded và shutdown; report shortcut không bỏ quyền/validation; pool đọc được dùng
cho cả findings, rows được đóng và slot được trả trước nested query; admission
timeout không gọi ClickHouse hoặc lấy mất slot của request khác.

Lần đầu chạy integration phát hiện fixture giả định AcceptCommand phát QUEUED
event, trong khi runtime chỉ phát ở bước workflow tiếp theo. Đã sửa fixture để
tạo snapshot QUEUED rõ ràng; runtime acceptance không bị thay đổi để khớp test.

Ở lần kiểm thử ban đầu, race detector, ClickHouse thật và PostgreSQL 17 chưa chạy
được vì thiếu môi trường. Các kiểm tra còn thiếu đã hoàn thành trên bản ứng viên
riêng trong mục dưới đây; kết quả local vẫn không chứng minh latency Cloud.

Lệnh kiểm thử PostgreSQL tại local (database phải là test):

```powershell
cd crawler
$env:WEBLENS_TEST_POSTGRES_URL='postgres://postgres@127.0.0.1:55449/weblens_test_crawler_cancel?sslmode=disable'
go test ./internal/postgres -run '^TestStoreWorkflowIntegration$' -count=1 -v
```

Cluster chỉ lắng nghe 127.0.0.1:55449, dùng data directory
`tmp/scan-cancellation-test-pg-20261003`. Đã dừng sau kiểm thử: pg_ctl xác nhận
server stopped/no server running, không còn listener trên port 55449. Dữ liệu
test được giữ. Không can thiệp database hoặc service production.

## Các bước còn lại trước kết luận hiệu năng

1. Chạy race detector, PostgreSQL 17 và ClickHouse integration trên môi trường test.
2. Chuẩn bị release chỉ gồm thay đổi được review, kèm bản sửa cancellation đã có;
   ghi phiên bản/artifact chính xác và phương án rollback runtime không thay schema.
3. So sánh API riêng, crawl riêng và tải kết hợp ở 25 → 100 → 500, giữ fixture và
   SLO cũ, cả startup/login errors. Theo dõi read admission/query, write batch,
   outbox age/throughput, applied outcomes, terminal identity và physical analytics.
4. Đánh giá pool 7/3 bằng cả report latency và ingest lag. Read capacity giảm từ
   pool shared 10 xuống 7; chưa chứng minh tổng thể nhanh hơn khi report có dữ liệu.
5. Đo queue/time-to-first-page, execution duration và tổng pages/s; fairness không
   tự chứng minh throughput tăng. Điều chỉnh một biến mỗi lần đo.

Chưa công bố API p95 < 1 giây hoặc event p95 < 5 giây đã đạt. Mục tiêu 1.000 vẫn
chờ phạm vi đã hỏi trước đó. Automation PAUSED; review index revision 1 pending;
global DEAD/orphan PERSISTING unknown. Giữ máy bật theo công việc còn mở.

## What the developer should understand before accepting this code

Progress event là snapshot versioned, không phải ledger của từng page mutation;
bỏ một snapshot trung gian không được bỏ durable page result hoặc terminal.
At-least-once vẫn có thể gửi trùng nếu callback thành công nhưng ack local thất bại;
inbox idempotency và version guard phải giữ nguyên. Khoảng nhảy version hợp lệ.

Connection pool tách budget để ingestion và report không tranh cùng slot, nhưng
cùng dùng server ClickHouse nên vẫn tranh CPU/IO. Admission timing đo queue tại
application, không được diễn giải thành thời gian native acquire/server thuần túy.

Fairness, throughput và latency là ba chỉ số khác nhau. Tăng claim concurrency
phải đi cùng kiểm tra lock, fencing và host policy. Các kiểm thử đúng đắn đã qua
không thay thế phép đo tải hoặc xác nhận SLO trên production.

## Bản ứng viên đã kiểm chứng ngày 03/10/2026

### Nguồn và phạm vi

Nhánh `codex/performance-runtime-verified`, commit
`91f1d35e0944573af7904648908b58430dd56f4f`, nằm tại
`C:\Users\HP\.codex\worktrees\performance-runtime-verify\Pet_project`.
Checkout sạch sau commit; giữ nguyên checkout chính và thay đổi khác của người dùng.
Chưa push, deploy, restart production hoặc phát workload mới.

HEAD checkout chính cũ hơn patch production. Crawler candidate dùng baseline
`ceb3a767b36d91a65725f8791839eb7fceb9727f`, giữ claim giới hạn/lock trước
enrichment, receipt lookup theo batch và timing opt-in. Backend giữ bốn file runtime
và test từ baseline production `56b0660e08bd0260d98808067dfb0bb999038bbb`,
gồm tối ưu transaction login/report và admission timing. So với baseline backend
đó, runtime chỉ đổi `ScanEntity` và `ScanStateMachine` để cancel không tự ghi
terminal. Không đổi schema, dependency, worker limit hoặc cấu hình production.

### Kiểm thử trên bản ứng viên

| Kiểm tra | Kết quả |
| --- | --- |
| Toàn bộ Go suite `-race -count=1`, đủ DB env | PASS; 105 action test/subtest, 0 fail/skip |
| PostgreSQL workflow integration | PASS trên PostgreSQL 17.6; 13 subtest của baseline này |
| ClickHouse batch/replay/report | PASS trên ClickHouse 26.3.39.7 |
| ClickHouse đọc và ghi đồng thời | PASS; 16 reader × 5 lượt pages/summary, writer 20 batch; counts/replay/pool đúng |
| `go vet ./...`, build Windows amd64 | PASS; Go 1.27.1, trimpath, CGO disabled |
| Backend unit tests liên quan | 36 PASS, 0 fail/error/skip |
| FoundationApiIT | 1 PASS, gồm JWT/website/scan/cancel/terminal lifecycle |
| FoundationPersistenceIT | 4 PASS; flush/clear trước đọc persistence |
| AuthenticationPersistenceIT | 4 PASS; transaction login và concurrent refresh thật |
| ScanCancellationIT | 5 PASS; terminal trễ, concurrency, rollback outbox và clone |
| Backend JAR package | PASS; Java 21; package cuối skip tests sau khi các suite trên đã đạt |

Database local WSL chỉ lắng nghe loopback. Mỗi backend suite dùng database
`weblens_test_*` riêng. Helper test chung hỗ trợ loopback PostgreSQL và giữ nhánh
Testcontainers mặc định; không thay runtime/assertions để vượt kiểm tra. Nhánh tự
tạo Testcontainers chưa chạy trong lượt này. 105 gồm subtest, không phải 105
integration độc lập. Integration thật đã dùng PostgreSQL 17 và ClickHouse local.

### Artifact và evidence

Thư mục: `tmp/releases/runtime-verified-20261003/`.

| Artifact | SHA-256 |
| --- | --- |
| `weblens-crawler.exe` | `7acd544fb1b1861192b462b975356397663fef71ce9e864b15c5ad3a7f52755e` |
| `weblens-backend.jar` | `e4bbd656fbb16f3e4a123dcacdd531ab9d3115b3bfe73f5e92873c05578309bb` |
| `source.patch` | `d5bd1840e28b5ebd09762b349ba48ec9f2dee81d01fea30a756830beb59a48cf` |

`manifest.json` lưu source/baseline, hashes, kết quả và trạng thái NOT_DEPLOYED.
`evidence/` gồm Go JSONL, Maven logs, backend summary bỏ system properties và
cleanup proof. Hai container test PG/ClickHouse EXITED; daemon Docker riêng đã
thoát, không còn listener 55450/8123/9000. Dữ liệu test/cache được giữ. Không
shutdown WSL/Windows hoặc can thiệp service production.

### Triển khai và đo tiếp

1. Trước triển khai, kiểm lại hash runtime đang chạy, routes off và workload phụ
   thuộc hai service. Hash tham chiếu: backend `924db7d2...`, crawler `586a1b84...`.
   Nếu khác, xác minh nguồn mới trước khi thay artifact.
2. Backend trước, crawler sau, dùng helper patch kiểm hash/rollback artifact.
   Nếu bước crawler thất bại, lưu trạng thái thật và xử lý/rollback cặp runtime;
   không tuyên bố toàn release đã triển khai. Không có migration/index.
3. Smoke đúng owner: scan nhỏ, progress/report/cancel/terminal; đối chiếu outbox,
   inbox outcome, identity, analytics và cleanup.
4. Đo 25 → 100 → 500, mỗi lần một workload. Tách API trên dữ liệu có sẵn, crawl
   riêng, rồi tải kết hợp; giữ fixture/pacing/timeout/SLO và startup/login errors.
   Report phải được đo khi có dữ liệu: shortcut rỗng không chứng minh tốc độ báo
   cáo đầy đủ. Đối chiếu cấu hình Cloud trước khi so sánh.
5. Lưu errors/p95 theo endpoint, admission/query-read time, ingest lag, event
   age/outcome, queue-to-first-page, duration/pages/s. Không loại lỗi harness hoặc
   nới SLO để đánh dấu PASS. Xác minh terminal, routes off, process thoát và backlog
   trong scope sau mỗi lượt; giữ seed nếu cleanup chưa đủ.

Rollback runtime không tự sửa 36 projection CANCELLED lịch sử. Event đã lấy mẫu
không được khôi phục thành từng mutation khi rollback; terminal/version guard và
dữ liệu durable cần đối chiếu. Pool 7/3 và fairness chưa benchmark trên Cloud:
candidate đã kiểm chứng tính đúng, chưa có kết quả capacity/SLO sau sửa.

Không thêm backup/global recovery gate hoặc guard RAM/CPU/health cho đo tải.
Health sau deploy chỉ kiểm artifact khởi động. Global DEAD/orphan PERSISTING vẫn
unknown; review index revision 1 pending. Lượt 1.000 chưa chạy vì phạm vi API-only
hay mỗi tài khoản tạo scan vẫn chờ câu trả lời đã hỏi. Automation PAUSED, giữ máy bật.

## Đã triển khai production ngày 03/10/2026

Theo yêu cầu triển khai của người dùng, đã cài backend trước rồi crawler từ
candidate `91f1d35e0944573af7904648908b58430dd56f4f`. Hash artifact sau cài
khớp bảng phía trên; helper lưu artifact runtime trước cài và hỗ trợ rollback
riêng từng component. Nếu crawler install thất bại, wrapper sẽ restore backend.
Không đổi schema, service XML, worker limit, Capture hoặc Caddy.

Probe trước cài xác nhận base `9e87e8b...`, hai hash runtime cũ đúng baseline,
active scans/executions 0, routes/hosts synthetic off và không thấy process tải/
collector thuộc WebLens. Query backlog ban đầu hết statement timeout; đã thu hẹp
vào active workload. Không dùng global recovery làm gate. IWR health probe cũng
timeout; curl trả HTTP 200/body UP. Helper cài dùng curl/body UP, giữ nguyên cơ chế
kiểm hash và rollback. Evidence helper thực thi được lưu cùng artifact.

### Smoke và đối chiếu cuối

- Registration, login, owner API, website và scan admission qua API public đạt.
- Scan một trang `example.com` COMPLETED; processed/succeeded=1, expected/published=1,
  report có một trang và fresh=true. Không dùng synthetic routes hoặc chạy fixture tải.
- Hủy scan mới trả CANCEL_REQUESTED rồi Crawler trả CANCELLED; không tự ghi terminal
  CANCELLED ngay trên Control Plane khi yêu cầu hủy được chấp nhận.
- Cấu hình production hiện vẫn maxPages=1.000. Smoke đầu bị assertion của harness
  `maxPages<=25` dừng; scan đã tạo được cancel/terminal/archive. Không sửa cấu hình
  production để vượt check. Smoke tiếp giới hạn qua target một trang đã kiểm link.
  Đây không phải phép đo 1.000 người hoặc 1.000 trang.
- Đối chiếu cả ba scan gồm attempt đầu: owner, status và progress version của Control
  Plane/Crawler khớp; final outbox DELIVERED, cùng message/version trong inbox APPLIED.
  Scope smoke có queued/leased/persisting=0 và pending/claimed/DEAD event/analytics=0.
- Hai website smoke đã archive; private credential được giữ tại local ignored tmp.
  Không xóa các seed workload cũ hoặc tự sửa 36 projection CANCELLED lịch sử.

Final proof lúc **06:09 UTC / 13:09 UTC+7**: Backend/Crawler/Capture health HTTP
200/body UP; Backend/Crawler/Capture/Caddy Running; active scans/executions 0;
routes/hosts tải off, không thấy process test/collector trong phép kiểm đã nêu.
Service XML hashes trước/sau bằng nhau. Global DEAD/orphan PERSISTING ngoài scope
vẫn unknown; không tuyên bố global recovery sạch.

Manifest hiện `DEPLOYED_SMOKE_VERIFIED`; evidence gồm pre/post/final probe,
hai patch manifest, smoke attempt đầu/cuối và terminal reconciliation. Lệnh rollback
từng component nằm trong manifest; khi rollback cặp, thực hiện crawler trước backend
sau khi xác minh workload và hash thực tế. Rollback runtime không backfill dữ liệu.

Chưa đo lại tải 25/100/500, chưa kết luận API latency/event lag/throughput sau sửa.
Lượt tiếp theo là phép đo 25 → 100 → 500 theo kế hoạch phía trên. 1.000 vẫn chờ
phạm vi đã hỏi; review index pending, automation PAUSED và Windows được giữ bật.
