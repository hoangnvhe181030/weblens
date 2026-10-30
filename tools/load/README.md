# Bộ công cụ load test WebLens

Thư mục này cung cấp công cụ Node.js 24 không cần cài package:

- `fixture.mjs`: website HTTP xác định, sinh tối đa 100.000 trang theo yêu cầu.
- `run.mjs`: chạy tải API hoặc điều phối một scan qua Control Plane rồi theo dõi đến trạng thái cuối.
- `local-admission-probe.mjs`: đo riêng admission Java với PostgreSQL/Redis cô lập và build từ source snapshot có hash.
- `recovery-index-probe.mjs`: thử hai recovery index bằng twin database synthetic trên Docker local; không nhận production target.
- `recovery-index-restore-drill.mjs`: restore ba dump off-host đã pin hash và rehearsal index trên Docker cô lập; evidence nhạy cảm giữ ngoài repo.
- `recovery-index-api-baseline-windows.ps1`: hai cửa sổ read-monitor 1 user trên dữ liệu benchmark production hiện hữu; dừng khi gate fail, không tạo scan.

Bộ công cụ chỉ tạo tải và ghi số đo. Nó không sửa migration, không tự đổi giới hạn
server và không tuyên bố hệ thống đạt production capacity. Kết quả luôn được ghi
dưới `tmp/load/*.json`, ngoại trừ production dump/restore/read-monitor evidence
phải vào thư mục riêng đã khóa NTFS ACL **ngoài repo**. `tmp/` được Git bỏ qua
không có nghĩa là dữ liệu nhạy cảm đã được bảo vệ khỏi tài khoản Windows khác.

WebLens chỉ còn một runtime. Các ví dụ bên dưới gọi Control Plane ở `8080`, Crawler
ở `8081` và fixture ở `9090`. Bài thử sẽ tạo dữ liệu trong database chính đang
kết nối, vì vậy chỉ chạy với tài khoản/website do bạn sở hữu và lập kế hoạch dọn
dữ liệu benchmark sau khi đã lấy metric.

## Nguyên tắc an toàn của runner

- Mặc định chỉ gọi `127.0.0.1` và luôn chạy health preflight trước khi tạo tải.
- Cấu hình lớn phải có `--acknowledge-high-load`. Cờ này không làm giảm tải; nó
  giúp tránh chạy nhầm một lệnh có thể làm cạn CPU, RAM, socket hoặc dung lượng đĩa.
- Mọi scenario đều hữu hạn: API cần `--operations`, `--duration`, hoặc cả hai;
  crawl chạy thật cần `--timeout`.
- Mỗi request có timeout và giới hạn số byte response mà load generator đọc.
- Không nhận password, bearer token, cookie hoặc header tùy ý từ CLI. Password chỉ
  được đọc từ `WEBLENS_LOAD_PASSWORD`; token tùy chọn chỉ từ
  `WEBLENS_LOAD_ACCESS_TOKEN`.
- Report và console không ghi email, password, token, cookie hoặc response body.
- URL có userinfo hoặc query key nhạy cảm bị từ chối.
- Target ngoài loopback cần đồng thời `--allow-non-loopback` và
  `--confirm-target-ownership`. Chỉ dùng chúng với môi trường kiểm thử do bạn sở hữu
  và đã cô lập; không dùng bộ công cụ này để tạo tải lên website công cộng.

## Đo admission local cô lập

### Benchmark full-stack và Design Clone local

```powershell
& 'C:\Program Files\apache-maven-3.9.12\bin\mvn.cmd' -B -f backend/pom.xml package -DskipITs
docker build -t weblens-benchmark-crawler:20261013 crawler
docker build -t weblens-benchmark-capture:20261013 capture-worker
node --test tools/load/local-platform-benchmark.test.mjs tools/load/k6-smoke-test.mjs
node tools/load/local-platform-benchmark.mjs --acknowledge-high-load
# Các lượt độc lập, không được tính là clone/full-stack PASS:
node tools/load/local-platform-benchmark.mjs --acknowledge-high-load --admission-only
node tools/load/local-platform-benchmark.mjs --acknowledge-high-load --api-only --balanced-mix
node tools/load/local-platform-benchmark.mjs --acknowledge-high-load --clone-only
```

Runner không nhận production target và không đọc `.env`. Nó tạo PostgreSQL với
ba database riêng, Redis, ClickHouse, MinIO, Java, Go, Capture và fixture tạm.
Fixture dùng địa chỉ dạng public **chỉ trong Docker network `--internal`**, không
có route Internet; Crawler/Capture/fixture chỉ nối network này. Java có thêm
bridge ingress để k6 truy cập qua loopback. Không sửa SSRF guard; topology này
không chứng minh egress isolation hoặc DNS/TLS production.

Clone smoke 100 URL rồi 1.000 URL qua public API, scan mới và Camoufox thật; tải
archive owner-scoped, kiểm SHA-256/size/header, semantic role/locale, asset dedup,
JS sau render và link offline. Đây là Design Clone, không phải 1.000 page render:
đầu ra chỉ giữ representative. Cùng key phải trả cùng clone/scan; owner khác nhận
404. Không có test tài khoản website, WAF/CAPTCHA hoặc browser crash trong runner.

Admission 25 owner distinct; API mixed 50 RPS/60s → 150 RPS/60s → 500 RPS/120s →
150 RPS/300s, tối đa 25 VU; mỗi iteration một GET, zero think time. Đọc dashboard,
website, scan history, progress và report của scan thật đã hoàn tất. Một nấc fail
dừng tăng tải. Nếu các nấc pass, chạy admission burst 150 owner mới với timeout 5s,
không replay POST. Gate ordinary API p95 <500ms/p99 <1s; report p95 <1s/p99 <2s;
error <0,1%, zero dropped iteration. Admission gate theo `crawler-submit.js`.
Mặc định route theo `__ITER` tạo report burst cùng pha lúc đầu. `--api-only
--balanced-mix` bật `WEBLENS_MIXED_ROUTE_OFFSET=1`, lệch role theo VU và giữ
threshold count>0 cho từng endpoint; đây là workload riêng, không phải fix backend
hay matched before/after. `--admission-only` chạy độc lập 150 owner với dispatcher
bật; không đo API/clone. Mỗi phase có scope trong manifest/outcome.
`--clone-only` chạy smoke 100, discovery 1.000, rồi hai clone 100 URL đồng thời;
kiểm metadata công khai và tổng byte ZIP + manifest, chạy bốn PostgreSQL/MinIO
integration test trên schema/prefix test riêng, rồi kiểm inventory sau GC. Nó
không chạy admission/mixed API và không được gắn PASS_FULL_STACK. Precision
createdAt cho phép tối đa 1ms giữa response trước commit và timestamp PostgreSQL
microsecond; không cho phép thay timestamp thành thời điểm worker nhận job.
Đối chiếu accepted scan với durable scan/outbox; không suy timeout thành thất bại
commit. k6 summary dùng `WEBLENS_SAFE_SUMMARY_FILE`, không `--summary-export`
(mặc định k6 có thể xuất setup token).

Evidence tại `tmp/load/platform-<UUID>/`: source/JAR/image hash, runtime manifest,
lifecycle, ZIP/manifest thật, k6 metrics-only summary, samples Docker mỗi 10s,
DB stats, log và cleanup. Source phải giữ nguyên trong suốt run; dirty source
không đủ điều kiện release. Script chỉ xóa container/anonymous volume/network có
label sở hữu của nó. Crash/kill runner cần dọn theo đúng run ID, không dọn toàn Docker.

Lỗi binding billing disabled đã được sửa bằng feature gate trên Properties và
regression có scanner. Runner **không còn cấp catalog/profile giả** khi billing
tắt. Workaround trong evidence baseline cũ là lịch sử, không ghi đè kết quả cũ.
Report stage snapshot là timer cumulative COUNT/TOTAL/MAX, không phải percentile.
ClickHouse query metadata local không chứa query/exception text hoặc credential;
không đủ quyền hoặc timeout thì ghi unavailable. Chi tiết trong
`docs/testing/LOCAL_PLATFORM_RELIABILITY_FIX_2026-10-13.md`.

Admission có thêm `admission-<count>-timing.json`: đối chiếu correlation/scan ID,
filter enter/exit và service timing; thiếu/trùng/sai log không thành complete
evidence. Percentile stage dùng nearest-rank, khác nội suy k6; không cộng các p95
độc lập. `withinFilterOutsideServiceMs` gồm auth, transaction entry và MVC/response;
`outsideFilterResidualMs` gồm scheduling/transport trước và sau filter. Không gọi
chúng là SQL time hay network time. Residual âm do precision vẫn giữ nguyên.
COMMITTED trong service log không thay durable receipt; status 0 không thành
accepted. File này chỉ chẩn đoán, không hạ gate SLO hoặc retry POST.
Admission chỉ consistent khi seed, response và durable receipt ánh xạ một-một;
observation trùng không được che request hoặc receipt thiếu. Khi đối chiếu fail,
không dùng scan ID để tạo workload API tiếp theo.

API có thêm `api-<phase>-cpu-quota.json`: đọc cgroup v2 `cpu.max`/`cpu.stat`
trước/sau toàn invocation k6 (gồm setup/login), xuất delta cho Java, Crawler và
ClickHouse. Throttled-period fraction/throttled milliseconds không phải request
latency, CPU utilization của riêng activity hoặc bằng chứng causal độc lập.
Counter thiếu/reset, quota đổi hoặc format sai được ghi unavailable; không thay
gate, quota hoặc max_threads. Probe ở ngoài cửa sổ activity.

Chạy offline regression: `node --test tools/load/local-platform-benchmark.test.mjs`.
Báo cáo đối chiếu evidence có sẵn ngày 14/10 tại
`docs/testing/LOCAL_ADMISSION_TIMING_DIAGNOSIS_2026-10-14.md` ghi checkpoint khi
Docker startup lỗi. Đợt tiếp nối sau khi engine hoạt động lại nằm trong
`docs/testing/LOCAL_API_REPLICATES_2026-10-14.md`; không ghi đè artifact lịch sử.

Máy sinh tải cũng chạy target; database mới và payload synthetic nhỏ không đại
diện 100.000 tài khoản, lịch sử 12 tháng hoặc VPS. Không công bố capacity production
hay cải thiện trước/sau nếu chưa có matched baseline trên cùng cấu hình/dataset.

```powershell
node --test tools/load/local-admission-probe.test.mjs
node tools/load/local-admission-probe.mjs --count 25 --rounds 3
node tools/load/local-admission-probe.mjs --count 150 --rounds 2 --hikari-max 32
```

Cần Java 21, Maven, Docker local, k6 và PowerShell 7. Probe copy source backend và
k6 admission vào thư mục mới dưới `tmp/load/admission-<UUID>/`, kiểm SHA-256 trước
và sau copy/build, chạy `mvn clean verify` và critical integration evidence gate.
Không dùng JAR có sẵn, không sửa output build trong backend chính. Source dirty
được ghi rõ và **không đủ điều kiện release**; snapshot này chỉ phục vụ đo cục bộ.

Probe tạo PostgreSQL/Redis riêng, bind loopback ở cổng ngẫu nhiên; Java cũng bind
loopback. Không nhận target bên ngoài, không đọc `.env` production. Cấu hình
runtime hiện có được dùng với dispatcher tắt bằng biến môi trường, không tạo
profile mới. Auth, Redis, durable revocation, quota và rate limit vẫn giữ nguyên.
Mỗi lượt dùng user/website/correlation/key riêng; registration và login pacing
1,1 giây. Website synthetic `admission.invalid` không được fetch vì không chạy
crawler. Một POST/key, timeout 5 giây; không retry admission.

Artifact gồm source/runtime manifests, hash JAR/image, clean-build log, seed
identity synthetic, k6 summary, observation và backend timing theo correlation.
Probe đối chiếu từng response với scan + outbox đã commit bằng SELECT ở database
do nó tạo. Không sửa status, expiry, quota hay migration để ép bài đo pass.
Thiếu/duplicate observation bị từ chối; response thành công nhưng thiếu bằng
chứng, identity lệch hoặc status 0 vẫn là failure/UNKNOWN. Gate latency/error
của k6 và reconciliation đều phải đạt; lỗi dừng các lượt sau.

`--count` nhận 1..150; `--rounds` nhận 1..3. Cell A mặc định là `--warm 0
--stagger-ms 0`; B dùng `--warm 1 --stagger-ms 0`; C dùng `--warm 0
--stagger-ms 20`; D dùng `--warm 1 --stagger-ms 20`. Mỗi cell chạy độc lập, ít nhất
ba lượt; chỉ tăng 25→50→150 sau gate. Warm/stagger đổi workload, không là bản sửa
backend hay bằng chứng giảm latency tương đương. Cell A không chủ động warm,
nhưng không bảo đảm mọi POST dùng socket mới; kiểm connecting/TLS timings.
Không coi JVM/cache là lạnh sau setup.

`--hikari-max` nhận 1..64, mặc định 64; minimum idle bằng `min(16, max)`.
Giá trị được truyền rõ vào Java và ghi trong runtime manifest. Dùng 32 để thử
maximum pool giống VPS; đây không phải sao chép toàn bộ cấu hình/phần cứng VPS.
Đổi pool cần giữ nguyên workload và so sánh nhiều lượt; không suy ra nguyên nhân
latency chỉ từ hai lần chạy khác nhau, không tự tăng tổng connection production.

Kết thúc hoặc lỗi được xử lý: probe dừng Java, kiểm label ownership rồi xóa đúng
container/anonymous volume tạm của nó. Evidence/source/build vẫn giữ lại. Nếu
kill hẳn runner hoặc máy crash, `finally` không được bảo đảm; cần kiểm container
bằng label `weblens.admission-probe=<runId>` từ manifest, không dọn container khác.

Đây là **admission-only trên cùng máy**, không có Caddy/TLS, background crawl,
ClickHouse hay Capture/S3. Database tăng giữa các lượt; chưa có matched baseline
trước sửa hay telemetry liên tục. Không dùng kết quả để công bố production API
p95, full-stack capacity hoặc nguyên nhân admission timeout production.

## Thử recovery index trên database cô lập

```powershell
node --test tools/load/recovery-index-probe.test.mjs
node tools/load/recovery-index-probe.mjs --profile smoke
node tools/load/recovery-index-probe.mjs --profile representative
```

Cần Go, Node.js và Docker local. Smoke seed 30.000 page / 60.000 event;
representative seed 1.296.711 page / 3.499.939 event mỗi database. Cardinality
lấy từ estimate production, nội dung synthetic không tương đương payload thật.
Disk guard 5/20 GiB, RAM guard 3 GiB; container giới hạn 2 CPU/1536 MiB,
PostgreSQL 17.11. Runner snapshot/hash source crawler, dùng migration CLI hiện
hữu, chỉ build index ngoài transaction trong database do nó sở hữu.

Artifact mới tại `tmp/load/recovery-index-<UUID>/`: manifest/runtime/source hashes,
EXPLAIN ANALYZE BUFFERS, SQL churn timing/WAL, sizes, catalog/functional checks,
final outcome và lỗi nếu có. Read có 12 mẫu/lookup; write có 20 mẫu, 1.000 row/mẫu.
SQL churn tuần tự không thay full worker publish/ACK/lease workflow hoặc tải đồng
thời; WAL chưa gồm commit record. Autovacuum chỉ tắt trên server test riêng.
Không reserve host hoặc bảo đảm cold cache; timings chỉ exploratory.
Seed commit batch 50.000 page/100.000 event, xác nhận actual cardinality riêng.
Lookup baseline timeout giữ `TIMEOUT`, không boolean hoặc p95; runner vẫn đo
candidate với timeout đọc 2 s. Khi đó outcome là `COMPLETED_WITH_BASELINE_TIMEOUT`,
không PASS baseline. Candidate timeout/lock/SQL error vẫn dừng; không tăng deadline.

Test functional/negative kiểm orphan terminal nhiều tháng/default/future partition,
rollback invisible, timestamp constraint, timeout không thành false, invalid build
cleanup và parent rollback bị read lock chặn. Cleanup kiểm UUID label, chỉ xóa
container/anonymous data của run; evidence giữ lại. Kill runner/máy crash có thể
bỏ qua finally: chỉ cleanup theo exact label/container trong manifest sau kiểm
ownership. Không chạm container khác.

Probe không release/deploy/mutate production, không sửa applied migration hay
Java code. Xem [runbook duyệt có điều kiện](../../docs/database/RECOVERY_INDEX_RUNBOOK.md)
trước mọi DDL production; local PASS không vượt DESIGN_GATES.

Restore drill hiện chỉ nhận đúng fresh backup ngày 2026-10-09 đã pin hash, cần
thư mục private dưới user home, không nhận target production hoặc bypass ACL.
Container PG 17.11 được pin image, `--network none`, không port, mount dump read-only,
2 CPU/1536 MiB. Restore dừng ở lỗi đầu; không restore role/ACL/global, không chạy
app/worker, không kích hoạt session và không chạm ClickHouse/R2/Redis. Xóa đúng
owned container/volume tạm sau run; giữ dump/log riêng. Backup không được đưa vào Git.
DDL rehearsal giữ 2 s read/metadata, 500 ms lock và 180 s concurrent build; không
phải maintenance runner production. Autovacuum chỉ tắt ở owned drill server.

```powershell
node --test tools/load/recovery-index-restore-drill.test.mjs
node tools/load/recovery-index-restore-drill.mjs --backup-dir <absolute-private-backup-directory>
```

Read-monitor dùng credential DPAPI/tài khoản/website/scan cũ, k6 `api-read.js` hiện
hữu, 1 VU × tối đa hai cửa sổ 30 s. Login vẫn tạo session bình thường; không seed,
POST scan, refresh/replay hoặc nới timeout. Failed gate trả nonzero và dừng cửa sổ
sau. **Không dùng default `--summary-export`**: k6 export cả `setup_data`, trong đó
script này giữ bearer token. Chỉ raw metrics/log vào private root; không dùng debug
HTTP/headers. Hai wrapper/tool này không đủ chứng minh full-stack production-ready.

## 1. Chạy crawl fixture

Ví dụ nhỏ:

```powershell
node tools/load/fixture.mjs --port 9090 --pages 100 --fanout 10 --delay 2ms --body-bytes 4096
```

Khi reverse proxy fixture dưới một đường dẫn synthetic riêng, thêm
`--base-path /__weblens-load`. URL được in ra sẽ có prefix này; link, canonical
và health endpoint của fixture cũng giữ cùng prefix. Runner `crawl` dùng chính
URL có prefix đó. Chỉ phục vụ đường dẫn này trên domain do bạn kiểm soát.

Fixture 100.000 trang:

```powershell
node tools/load/fixture.mjs `
  --port 9090 `
  --pages 100000 `
  --fanout 32 `
  --delay 0ms `
  --body-bytes 4096 `
  --robots allow `
  --acknowledge-high-load
```

Các endpoint:

- `GET /`: trang số 0.
- `GET /page/{id}`: trang từ 1 đến `pages - 1`.
- `GET /robots.txt`: trả chính sách chọn bằng `--robots allow|deny`.
- `GET /__fixture/health`: health và cấu hình máy sinh trang.

Đồ thị link là cây xác định. Trang `i` liên kết tới các trang từ
`i * fanout + 1` đến `i * fanout + fanout` nếu ID còn trong phạm vi. Với 100.000
trang và fanout 32, crawler cần `maxDepth >= 4`.

Fixture không tạo mảng 100.000 trang trong RAM. Nó tính link khi nhận request và
stream phần padding bằng buffer dùng chung. `--body-bytes` là kích thước chính xác
của mỗi HTML response; chương trình từ chối cấu hình quá nhỏ để chứa toàn bộ link.
Nhấn `Ctrl+C` để dừng fixture.

Trên VPS Windows, dùng `manage-fixture-windows.ps1` để fixture chỉ lắng nghe ở
loopback. Script ghi PID và log riêng, từ chối cổng đã có listener và kiểm tra
health trước khi báo thành công:

```powershell
cd C:\ProgramData\WebLens\performance-fixture
.\manage-fixture-windows.ps1 -Action start
.\manage-fixture-windows.ps1 -Action status
.\manage-fixture-windows.ps1 -Action stop
```

Lệnh `start` mặc định sinh 1.000 trang ở
`http://127.0.0.1:19090/__weblens-load/`. Bước này chưa sửa Caddy và chưa tạo
scan. Chỉ cấu hình reverse proxy sau khi `status` báo `healthy: true` và đã xác
nhận mọi path ngoài prefix trả 404.

Trước khi mở route công khai, chuyển fixture sang Windows service tạm thời dùng
tài khoản ảo ít quyền. Dừng bản chạy thủ công, rồi cài service:

```powershell
.\manage-fixture-windows.ps1 -Action stop
.\manage-fixture-service-windows.ps1 -Action install
.\manage-fixture-service-windows.ps1 -Action status
```

Kết quả phải có `serviceAccount` là `NT SERVICE\WebLensFixture`, `running` và
`healthy` đều là `true`. Khi kết thúc toàn bộ benchmark, tắt route rồi chạy
`.\manage-fixture-service-windows.ps1 -Action uninstall`.

Trên production Windows hiện tại, route tạm thời được quản lý riêng. Script sao
lưu Caddyfile, validate trước khi restart và tự hoàn tác nếu kiểm tra công khai
không trả đúng JSON/trang fixture:

```powershell
.\manage-fixture-route-windows.ps1 -Action enable
.\manage-fixture-route-windows.ps1 -Action status
.\manage-fixture-route-windows.ps1 -Action disable
```

`enable` làm gián đoạn HTTPS ngắn trong lúc restart service `WebLensCaddy`.
Luôn chạy `disable` khi kết thúc đợt benchmark hoặc trước khi rollback release.

Sau khi route và service đều khỏe, chạy preflight E2E đúng một trang lá. Script
dùng tài khoản `weblens-load@jobnext.top`, yêu cầu nhập mật khẩu ẩn, tạo tài khoản
nếu chưa tồn tại, rồi chạy một scan và một browser capture. Hãy lưu mật khẩu này
trong password manager để dùng lại cho k6; không gửi mật khẩu trong chat.

```powershell
.\preflight-production.ps1
```

Target cố định là `https://jobnext.top/__weblens-load/page/999`, không có link con.
Report JSON không chứa email, mật khẩu, cookie hoặc access token và được lưu dưới
`C:\ProgramData\WebLens\performance-fixture\runtime\preflight-*.json`.

> Crawler phải dùng `CRAWLER_LOCAL_TARGETS_ONLY=true` khi gọi fixture local nhưng vẫn chặn
> public IP, link-local và metadata endpoint. Không tắt toàn bộ SSRF guard chỉ để
> truy cập fixture.
>
> API đăng ký website hiện từ chối `localhost` và IP riêng. Vì vậy fixture
> loopback này chỉ dùng để tự kiểm thử runner; các bước crawl E2E bên dưới cần
> hostname synthetic do bạn sở hữu và một môi trường test được cấu hình phù hợp.
> Không nới chính sách SSRF trên production để chạy benchmark.

## 2. Chạy tải API

### k6: đo luồng đọc có xác thực

Cài k6 trên Windows bằng `winget install k6 --source winget`, rồi xác nhận với
`& 'C:\Program Files\k6\k6.exe' version` (hoặc `k6 version` sau khi mở terminal mới).
Kịch bản [k6/api-read.js](k6/api-read.js) đăng nhập một lần, kiểm tra
website thuộc tài khoản, sau đó đo dashboard, danh sách website và lịch sử scan.
Nếu có scan ID, nó đo thêm tiến độ và danh sách page. Kịch bản chỉ đọc trong giai
đoạn đo, không tạo thêm scan hoặc gọi website đích. Dùng tài khoản và dữ liệu của
môi trường kiểm thử riêng; không đưa mật khẩu vào tham số dòng lệnh hay report.

```powershell
$secret = Read-Host 'WEBLENS_PASSWORD' -AsSecureString
$env:WEBLENS_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
$env:WEBLENS_EMAIL = 'load-owner@example.test'
$env:WEBLENS_WEBSITE_ID = '<website-id-thuoc-tai-khoan>'
$env:WEBLENS_VUS = '1'
$env:WEBLENS_DURATION = '30s'

New-Item -ItemType Directory -Force ./tmp/load | Out-Null
& 'C:\Program Files\k6\k6.exe' run `
  --out json=./tmp/load/api-read.jsonl `
  --summary-export ./tmp/load/api-read-summary.json `
  tools/load/k6/api-read.js

Remove-Item Env:WEBLENS_PASSWORD,Env:WEBLENS_EMAIL,Env:WEBLENS_WEBSITE_ID,Env:WEBLENS_VUS,Env:WEBLENS_DURATION
```

Đặt `WEBLENS_SCAN_ID` để đo hai endpoint kết quả. Mặc định k6 chỉ nhận
`http://127.0.0.1:8080`; mục tiêu ngoài máy local cần đặt
`WEBLENS_BASE_URL`, `WEBLENS_ALLOW_REMOTE=1` và
`WEBLENS_CONFIRM_TARGET_HOST` bằng đúng hostname của URL. Hơn 20 virtual user cần
`WEBLENS_ACK_HIGH_LOAD=1`. Token chỉ được lấy một lần nên giữ mỗi lượt chạy dưới
15 phút. Ngưỡng lỗi dưới 1%, p95 dưới 300 ms và p99 dưới 1 giây là
**giả thuyết đo ban đầu**, chưa
phải SLO đã được duyệt. Chỉ tăng tải sau khi các cổng trong
[báo cáo trước load test](../../docs/testing/PRE_LOAD_TEST_RESULTS.md) đạt yêu cầu.

Bộ `run.mjs crawl` bên dưới vẫn là công cụ cho một scan thật, vì nó kiểm tra fixture,
giới hạn scan, trạng thái cuối và hủy khi hết thời gian; k6 không lặp lại luồng đó.

### Runner Node.js hiện có

Smoke test health với 20 virtual user và 2.000 request:

```powershell
node tools/load/run.mjs api `
  --base-url http://127.0.0.1:8080 `
  --path /actuator/health `
  --virtual-users 20 `
  --operations 2000 `
  --request-timeout 2s
```

Tải một endpoint cần đăng nhập bằng một tài khoản dùng chung:

```powershell
$secret = Read-Host 'WEBLENS_LOAD_PASSWORD' -AsSecureString
$env:WEBLENS_LOAD_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password

node tools/load/run.mjs api `
  --base-url http://127.0.0.1:8080 `
  --path /api/v1/me `
  --email load-owner@example.test `
  --virtual-users 1000 `
  --duration 2m `
  --request-timeout 5s `
  --acknowledge-high-load

Remove-Item Env:WEBLENS_LOAD_PASSWORD
```

100.000 virtual user, mỗi user thực hiện tối đa một request:

```powershell
node tools/load/run.mjs api `
  --base-url http://127.0.0.1:8080 `
  --path /actuator/health `
  --virtual-users 100000 `
  --operations 100000 `
  --request-timeout 10s `
  --report-interval 2s `
  --acknowledge-high-load
```

`virtual-users` ở đây là số vòng lặp request đồng thời trong load generator, không
phải 100.000 row `users` khác nhau. Khi có `--email`, các virtual user dùng chung
một access token. Việc seed 100.000 identity là workload riêng và không nên trộn
với benchmark latency của một endpoint.

## 3. Lập kế hoạch một scan lớn

Khởi động fixture trước, sau đó kiểm tra ba health endpoint và khả năng cung cấp
đủ trang mà không tạo user, website hoặc scan:

```powershell
node tools/load/run.mjs crawl `
  --base-url http://127.0.0.1:8080 `
  --crawler-health-url http://127.0.0.1:8081/health/ready `
  --fixture-url http://127.0.0.1:9090/ `
  --pages 100000 `
  --plan-only `
  --acknowledge-high-load
```

Kế hoạch cho biết `maxPages` và `maxDepth` tối thiểu mà server phải cung cấp.
Control Plane hiện không có capability endpoint công khai, nên runner chỉ đọc
được `effectiveConfig` sau khi API đã tạo scan.

## 4. Chạy một scan tối đa 100.000 trang

```powershell
$secret = Read-Host 'WEBLENS_LOAD_PASSWORD' -AsSecureString
$env:WEBLENS_LOAD_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password

node tools/load/run.mjs crawl `
  --base-url http://127.0.0.1:8080 `
  --crawler-health-url http://127.0.0.1:8081/health/ready `
  --fixture-url http://127.0.0.1:9090/ `
  --pages 100000 `
  --email load-owner@example.test `
  --timeout 6h `
  --poll-interval 2s `
  --request-timeout 10s `
  --report-interval 5s `
  --acknowledge-high-load

Remove-Item Env:WEBLENS_LOAD_PASSWORD
```

Runner thực hiện theo thứ tự:

1. Kiểm tra health của Control Plane, Crawler và fixture.
2. Xác thực bằng bearer token đã cấp qua biến môi trường hoặc login một lần.
3. Tìm website có canonical URL trùng fixture; nếu chưa có thì đăng ký website.
4. Tạo đúng một scan với idempotency key ngẫu nhiên.
5. Đối chiếu `effectiveConfig.maxPages` và `maxDepth` với fixture. Nếu chưa đủ,
   runner yêu cầu hủy scan và báo lỗi rõ ràng.
6. Poll trạng thái đến terminal hoặc hết `--timeout`. Mặc định runner yêu cầu hủy
   khi timeout; dùng `--no-cancel-on-timeout` nếu muốn scan tiếp tục chạy.

Nếu đã biết website ID, truyền `--website-id <uuid>` để bỏ bước tìm/tạo website.
Runner vẫn đọc website này và yêu cầu `canonicalUrl` trùng chính xác với fixture
đã chuẩn hóa; nếu lệch, nó dừng trước khi tạo scan để tránh tải nhầm target.
Runner không truyền `maxPages` trong body vì API V1 hiện lấy giới hạn từ cấu hình
Control Plane; nó chỉ xác minh snapshot cấu hình mà API trả về.

## 5. Đọc kết quả

Trong khi chạy, console chỉ in aggregate metrics định kỳ. Report JSON cuối gồm:

- profile máy phát tải: phiên bản Node, OS, kiến trúc, số CPU logic và RAM;
- cấu hình scenario đã loại dữ liệu xác thực;
- request đã bắt đầu/hoàn tất, thành công/thất bại, timeout và max in-flight;
- throughput trung bình;
- latency `min`, `mean`, `p50`, `p95`, `p99`, `max` theo milliseconds;
- histogram HTTP status và nhóm lỗi mạng;
- với crawl: scan ID, tiến độ cuối, effective config và trạng thái terminal.

Latency percentile dùng histogram độ phân giải 1 ms. Giá trị vượt request timeout
được gom vào bucket tràn, còn `max` vẫn giữ latency quan sát thực tế.

Runner không áp một SLO pass/fail vì mục tiêu saturation là quan sát điểm gãy.
HTTP/network error vẫn được ghi là `COMPLETED_WITH_ERRORS`; lỗi cấu hình, preflight
hoặc contract làm tiến trình trả exit code khác 0.

Smoke test hoàn toàn local, dùng mock Control Plane/Crawler và fixture ở cổng ngẫu
nhiên:

```powershell
node tools/load/smoke-test.mjs
```

Thu mẫu host/process trên máy phát tải (một file mới, không ghi đè):

```powershell
./tools/load/collect-windows.ps1 -OutputPath ./tmp/load/host-sample.jsonl -DurationSeconds 60 -IntervalSeconds 5
```

Mỗi dòng JSON chứa thời điểm UTC, CPU/RAM host, disk/network I/O, TCP theo trạng
thái, Windows service và PID, parent PID, CPU tích lũy, I/O, thread, handle,
working set của tiến trình Java, PostgreSQL, Crawler, Capture/Node, browser,
Caddy và k6. Collector không đọc command line của tiến trình.

Trên VPS WebLens, bật các nguồn production bằng cờ riêng. Script đọc credential
từ `C:\ProgramData\WebLens\weblens.env` trong bộ nhớ chỉ để gọi loopback PostgreSQL,
Actuator và ClickHouse; credential, connection URL và câu SQL không được ghi vào
artifact:

```powershell
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
.\collect-windows.ps1 `
  -ProductionTelemetry `
  -OutputPath ".\runtime\telemetry-$runId.jsonl" `
  -DurationSeconds 600 `
  -IntervalSeconds 5
```

Production mode thu JVM/GC/thread, Hikari và Tomcat từ Actuator có service token;
connection/wait/lock/counter và queue/retry aggregate của ba PostgreSQL; row
counter của hai database ClickHouse; browser process và capture/site clone queue.
Mọi truy vấn PostgreSQL có statement timeout 2 giây; ClickHouse có timeout 4 giây.
Nếu `pg_stat_statements` chưa bật, collector ghi `extension-disabled`. R2 hiện
không cấp provider telemetry cho collector nên trường đó ghi rõ `not-available`;
byte/object reference vẫn được đối chiếu từ PostgreSQL Capture.

Chạy kiểm tra collector sau mỗi thay đổi:

```powershell
.\tools\load\collector-smoke-test.ps1
```

Smoke test dùng credential giả và endpoint không tồn tại, sau đó xác nhận JSON
parse được, nguồn thiếu được báo đúng và secret giả không xuất hiện trong output.
Chạy collector riêng trên máy phát tải và máy đích, đối chiếu PID service trước
khi phân tích. CPU tiến trình và các counter database là số tích lũy; tính delta
giữa các mẫu để lấy tốc độ trong cửa sổ.

Browser được đếm tổng trên host và phân nhóm theo executable path: dưới
`C:\WebLens\` là browser cài cho WebLens, ngoài thư mục này là process ngoài;
path không đọc được ghi `unknown`. Cách này nhận cả process mồ côi dùng binary
WebLens; không coi tổng Chrome toàn VPS là số worker Capture hoặc bằng chứng
rò rỉ. Recovery phải kiểm nhóm WebLens và unknown, đồng thời báo tải ngoài.

Ngay trước baseline, tạo snapshot mới của ba PostgreSQL. Script đọc credential từ
tệp environment được bảo vệ, tạo custom-format dump, chạy `pg_restore --list` và
ghi SHA-256; manifest không chứa credential hoặc connection URL:

```powershell
.\backup-production-postgres-windows.ps1
```

Chỉ coi thư mục có `manifest.json` là backup hoàn tất. Sao chép cả thư mục ra
khỏi VPS và kiểm tra lại SHA-256 trước khi tạo tải. Script này không backup
ClickHouse Cloud hoặc Cloudflare R2 và không thay thế restore drill; hai store đó
cần quy trình recovery riêng của provider.

## Admission timeout và tiếp tục workload đã xác minh

`crawler-submit.js` giữ timeout POST 5 giây, mỗi VU gửi một POST. Giới hạn scenario
30 giây không là request timeout. `scan_admission_duration` chỉ đo HTTP response
(status > 0); `scan_admission_elapsed` đo thời gian trước/sau POST của mọi attempt,
gồm transport failure. Cả hai có threshold p95 < 1.000 ms/p99 < 2.000 ms. Không so
trend HTTP mới với trend cũ có status-0/duration-0 mà không ghi rõ khác biệt mẫu.
Error rate/checks vẫn gồm attempt thất bại. Observation lưu elapsed, transport
error và blocked/connect/TLS/send/wait/receive; không log token/password/body.

Harness `tmp/load/phase8-run-150x1000.ps1` và wrapper scheduled hỗ trợ opt-in
`-ContinueVerifiedAdmissions`. Tùy chọn này cho phép chạy API với đủ 150/500 tài
khoản và theo dõi các scan đã xác minh sau admission thiếu identity hoặc threshold
thất bại. Người chưa có scan chỉ dùng dashboard/websites/history; không đọc route
scan ID null. `WEBLENS_MIXED_ALLOW_MISSING_SCAN=1` chỉ được truyền cho mixed k6 khi
opt-in. Mặc định yêu cầu đủ scan; không có scan xác minh hoặc k6 lỗi chạy khác
0/99 luôn chặn. Operational gates giữ nguyên và độc lập với tùy chọn tiếp tục.

Manifest/state lưu requested/accepted/committedObserved/unresolved cùng số API
users có scan. Admission lỗi hoặc identity chưa xác minh vẫn giữ outcome failure,
không công bố đủ 500 scan/500.000 trang. Owner-scoped reconciliation, cancellation,
terminal proof và giữ credentials khi unknown không đổi. API vẫn chạy 10 phút,
không đại diện API liên tục suốt crawl. Harness lưu correlation UUID trước POST để
đối chiếu trực tiếp với Backend timing logger khi đã triển khai và bật DEBUG có giới
hạn; stage timing không phải SQL/acquisition riêng.

Kiểm thử offline, không phát tải:

```powershell
node tools/load/k6-smoke-test.mjs
powershell.exe -NoProfile -File tools/load/phase8-harness-smoke-test.ps1 -ScanCount 500
pwsh -NoProfile -File tools/load/performance-failure-smoke-test.ps1
```

## Kiểm tra đọc sau khi chuyển Redis local (2026-10-12)

`local-redis-vps-load.ps1` chỉ dành cho cohort và thư mục DPAPI đã kiểm tra của
VPS hiện tại; không phải harness seed tổng quát. Chạy off-host với `-Phase baseline`
(25 owner, 60 giây) hoặc `-Phase load` (50 owner/120 giây, 150 owner/300 RPS/180
giây, rồi 150 owner/100 RPS/10 phút). Các phase chỉ đọc dữ liệu owner-scoped có
sẵn; không tạo scan. Đăng nhập được pace và loại khỏi activity metrics. Có 146
owner có scan và 4 owner chỉ đọc dashboard, website, history; không coi cohort này
là 150 scan mới hoặc 1.000 CCU.

`mixed-activity.js` ghi p99 và counter owner giả lập để kiểm số owner thực sự
tham gia. API thường có gate p95 <500 ms/p99 <1 giây, report và overall p95 <1
giây/p99 <2 giây, activity error <0,1%, arrival-rate không được drop iteration.
Summary chỉ xuất metrics/state, không xuất JWT trong setup_data. Harness giữ exit
99 là thất bại SLO và vẫn cho phase tải thấp hơn chạy để quan sát recovery; lỗi
setup/generator khác 0/99 chặn phase tiếp theo. Manifest giữ hash script, thời
gian, owner mix và exit code. Không đổi cấu hình/restart dịch vụ giữa một bài tải.

Đây là kiểm tra chẩn đoán đọc. Khi scan/capture E2E hoặc recovery gate chưa đạt,
không dùng bài này để tuyên bố workload toàn hệ thống đạt. Kết quả cụ thể được
ghi tại [báo cáo VPS ngày 12/10](../../docs/testing/VPS_LOCAL_REDIS_PERFORMANCE_2026-10-12.md).

## Giới hạn cần hiểu trước khi kết luận

- Một tiến trình Node và một máy Windows có thể cạn socket, ephemeral port, CPU
  hoặc RAM trước server. 100.000 virtual user không đồng nghĩa chắc chắn có
  100.000 TCP connection hoạt động cùng một thời điểm.
- Muốn phân biệt load-generator saturation với server saturation, theo dõi đồng
  thời CPU/RAM/socket của cả hai phía và chạy lại từ nhiều máy phát tải.
- `run.mjs crawl` tạo một scan; số crawler worker thật do Crawler Service quyết
  định. Script không giả lập 10.000 worker và không bypass lease/fencing.
- Fixture đo pipeline crawl trong mạng local, không đại diện DNS, TLS, bandwidth,
  politeness hay độ trễ Internet.
- Report page-level hiện có thể bị API giới hạn số item trả về; dùng progress và
  database/ClickHouse metrics để xác nhận đủ 100.000 page result.
- Trước khi công bố capacity trong CV, ghi lại cấu hình phần cứng, container,
  PostgreSQL, ClickHouse, connection pool, dataset, thời lượng, cache state và tỷ
  lệ lỗi. Một lần chạy đến khi sập chỉ xác định một failure point của cấu hình đó.
