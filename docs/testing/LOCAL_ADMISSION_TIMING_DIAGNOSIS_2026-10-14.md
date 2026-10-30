# Admission timing và report overload — 2026-10-14

Ghi chú lịch sử: phần dưới ghi checkpoint khi Docker còn lỗi. Docker đã hoạt
động lại sau khi người dùng chọn tự xử lý; không sửa socket hoặc reset dữ liệu.
Kết quả benchmark tiếp nối được ghi riêng trong
[báo cáo replicate API](LOCAL_API_REPLICATES_2026-10-14.md); không ghi đè evidence cũ.

## Kết luận

Tiếp nối [báo cáo ngày 13/10](LOCAL_PLATFORM_RELIABILITY_FIX_2026-10-13.md).
Chưa sửa runtime hoặc tuning: evidence hiện có thu hẹp latency local vào phần
ngoài thân service, chưa chứng minh root cause timeout production. Đã bổ sung
đối chiếu admission timing tự động và regression, dùng source/log đã có, không
phát tải mới. API 150 RPS vẫn FAIL, production full workload vẫn NO_GO.

## Phạm vi và blocker thực tế

- Source runtime và JAR trước khi sửa harness khớp hash manifest `fe28cdf4`.
  Harness thay đổi sau đó; không dùng hash harness cũ cho các lượt chạy tương lai.
- Docker Desktop không chạy khi preflight. Khởi động thông thường vẫn crash,
  engine pipe không tồn tại. Backend log 2026-10-14 09:51:38 UTC (16:51:38 UTC+7)
  ghi `initializing Secrets Engine` và không truy cập/xóa được `engine.sock`.
  Socket là reparse point, zero bytes; đây không chứng minh container data bị hỏng.
- Không xóa socket, factory reset, đổi phiên bản, sửa WSL hoặc xóa container/volume.
  Người dùng trước đó chọn tự xử lý Docker; đợt này chỉ thử khởi động và đọc metadata.
  Không dùng production/cloud làm đường vòng cho local benchmark.
- Ba matched replicate, query EXPLAIN/profile mới, cgroup throttling và Java/JFR
  sampling chưa chạy. Không gọi phân tích artifact cũ là benchmark mới.

## Thay đổi nhỏ, không đổi gate

`tools/load/local-platform-benchmark.mjs` thêm pure helper
`summarizeAdmissionTimings()` và xuất `admission-<count>-timing.json` sau admission.
Helper join exact correlation/scan ID giữa observation, filter enter/exit và
service timing; log thiếu, trùng, sai identity/status, numeric invalid hoặc stage
không thuộc allowlist đều không thành complete evidence. Không xuất raw log,
email/password/token hoặc arbitrary field. Giới hạn 150 observation/64 MiB log.

Chỉ trả aggregate timing và năm request chậm nhất; không sửa observation/receipt,
không retry POST, không đổi latency/error/drop gate. `COMMITTED` là service log
đã đối chiếu, không thay bằng chứng SELECT durable scan/outbox. HTTP status 0
vẫn transport failure, không accepted; response 202 nhưng không có scan ID không
thành complete timing. Diagnostic unavailable không tự biến runtime thành pass.

`tools/load/local-platform-benchmark.test.mjs` thêm regression; README giải thích
artifact và giới hạn. Không đổi Java/Go/Capture source, SQL, migration/schema,
dependency, kiến trúc ba deployable hoặc DESIGN_GATES. Không commit/push/deploy.

## Phân rã admission từ evidence cũ

Đối chiếu đủ 150/150 request của `ad50f00c`; đủ 25/25 của `fe28cdf4` và `42bc9fa4`.
Không gộp các run thành một distribution. Bảng sau dùng **mean của cùng tập request**,
không phải tổng các p95:

| Duration / residual | Admission 150, `ad50f00c` | Admission 25, `fe28cdf4` |
| --- | ---: | ---: |
| Client elapsed | 1.399,813 ms | 487,720 ms |
| Trong filter | 931,967 ms | 479,684 ms |
| Thân service | 174,527 ms | 245,547 ms |
| Sau thân service đến afterCompletion log | 24,770 ms | 3,704 ms |
| Trong filter nhưng ngoài hai service interval trên | 732,670 ms | 230,433 ms |
| Client elapsed trừ filter duration | 467,847 ms | 8,036 ms |

Hai residual lớn nhất ở burst 150; nhưng run 25/150 có source/runtime warmup,
dataset và workflow khác nhau. Không gọi đây là matched scalability curve hoặc
bằng chứng bản sửa cải thiện hiệu năng. Baseline 150 trước billing/proxy fix;
`fe28cdf4` là source đã sửa và database mới. Không suy phần body lớn hơn ở 25
thành lỗi regression nếu chưa replicate cùng cấu hình.

Request chậm nhất của burst 150, correlation suffix `d6a6`:

- Client elapsed 1.796 ms; filter 1.078,917 ms.
- Body 104,394 ms; after-body interval 1,847 ms.
- Within-filter residual 972,676 ms; outside-filter residual 717,083 ms.
- Service body + after-body khoảng 106,242 ms (5,9% elapsed); phần còn lại khoảng
  1.689,758 ms. Đây là cùng một request, không cộng percentile của request khác.

Trong burst 150, k6 mean blocked 2,487ms / connecting 2,441ms / TLS 0 / sending
0,377ms / waiting 1.362,613ms / receiving 34,220ms. Connecting nằm trong blocked,
không cộng hai số đó. Waiting không là SQL time: gồm các khoảng server/queue và
transport chưa tách. Không có timeout 5s ở run này; accepted và durable receipt
đã khớp trong evidence gốc.

### Ý nghĩa và giới hạn instrument

Filter bắt đầu trước Spring Security. Service timing bắt đầu **sau** transaction
interceptor đã vào `create()`, nên connection acquisition/transaction entry có
thể nằm ngoài body. Within-filter residual còn chứa JWT/session Redis + durable
revocation, method authorization, controller/MVC, serialization và scheduling.
Không có timing đủ để tách các thành phần này trong artifact cũ.

After-body interval chứa commit/transaction synchronization nhưng không phải riêng
WAL fsync hoặc thời gian SQL. Stage `user_lock`, `save_and_flush`, `outbox_enqueue`
đo call interval, gồm JVM scheduling, persistence/driver và database wait; không
được gọi là pure SQL hoặc chắc chắn row-lock contention. Hikari pending sampled 0
không loại trừ transient acquisition; 150 distinct owners cũng không chứng minh
không có lock/contention ở tầng khác.

Outside-filter residual có thể chứa socket/connector dispatch queue, JVM hoặc
generator scheduling, response flush/receive và transport. Không tự gán 468ms
trung bình thành network bottleneck. Các duration dùng monotonic clock riêng;
trừ duration không cần so wall-clock host nhưng vẫn có precision/instrument bias.
Residual âm được giữ thay vì clamp để tránh che sai lệch.

Helper dùng nearest-rank. Burst 150 elapsed p95 1.788ms/p99 1.796ms; k6 gốc nội
suy p99 1.795ms. Đây là khác estimator, không phải dữ liệu đổi. Giữ k6 gốc cho SLO;
không cộng p95 body, completion và residual để tạo API p95.

## Report overload: bổ sung từ metadata cũ

`fe28cdf4`: 50 RPS pass; 150 RPS có 29/9.000 `SCAN_REPORT_BUSY`, zero drop.
Auth timer delta 1.801, remote delta 1.772 = đúng 29 rejection trước remote.
Giới hạn Java report mặc định 8 slot không đổi. Với 1.772 call × 3 query,
metadata có đúng 5.316 QueryFinish trong cửa sổ burst, zero exception.

| Query metadata | Balanced 50 RPS | Balanced 150 RPS |
| --- | ---: | ---: |
| QueryFinish | 1.800 | 5.316 |
| Server duration mean / p95 | 11,157 / 18 ms | 20,663 / 83 ms |
| Tổng read rows / bytes | 120.000 / 14.751.600 | 354.400 / 43.566.392 |
| Read rows mean / max mỗi query | 66,667 / 100 | 66,667 / 100 |
| Tổng UserTimeMicroseconds quy đổi giây | 16,216 s | 59,900 s |
| Tổng SystemTimeMicroseconds quy đổi giây | 3,977 s | 12,650 s |

Metadata xuất bởi runner, không query/exception text. Baseline query-start
11:15:29.475614–11:16:29.184491 UTC; burst 11:17:03.228483–11:18:03.188511 UTC.
ProfileEvents CPU là counter query, không toàn bộ CPU server hay thời gian wall
clock. Không dùng tổng query duration/CPU để tính utilization container; query
overlap và background work chưa tách. Server-query p95 không phải API p95.

Read volume **mỗi query** không tăng giữa hai cửa sổ trên; query count và server
duration tăng. Điều này chưa ủng hộ giả thuyết dữ liệu lớn lên là nguyên nhân trong
chính lượt này, nhưng dataset chỉ có 25 leaf scans và không đại diện production.
Chưa có EXPLAIN để tách view FINAL, join/aggregation, sort, parts/granularity và
thread/scheduler cost. CPU sample ClickHouse gần cap 2 CPU là dấu hiệu pressure,
không đủ chứng minh riêng throttling hoặc chọn giảm/tăng max_threads.

## Kiểm thử và việc cần làm tiếp

- Fail-first: test import helper chưa tồn tại thất bại. Sau implementation: **13
  pass, 0 fail/skip** cho local-platform, local-admission, k6-smoke và smoke-test;
  Node syntax check pass. Smoke dùng fixture/mock local, không production probe.
- Diagnostic helper đã áp dụng đọc-only vào ba artifact cũ và đối chiếu đủ mọi
  request. Wiring lấy Docker logs khi live admission chưa chạy được trong đợt này.
- UTF-8 **4 file pass**, không repair; README `git diff --check` pass (chỉ warning
  LF/CRLF). Các file harness chưa tracked từ trước nên không coi `git diff` với
  HEAD là toàn bộ diff riêng của đợt này; đã kiểm source và test trực tiếp.
- Không rebuild JAR/image hoặc chạy Java/Go/Capture suite: runtime không đổi.
  Kết quả 181 Java unit, 22 billing IT và 4 PG/MinIO từ ngày trước giữ nguyên ngày,
  không ghi thành kết quả chạy lại hôm nay.

Thứ tự tiếp theo khi Docker sẵn sàng:

1. Preflight engine/image/source/JAR hash; kiểm label trước cleanup. Ba API-only
   balanced run độc lập trên cùng code, config, 25 leaf scans, limits và warmup;
   từng run dừng tăng tải nếu gate fail. Không cho 500/soak chạy qua failure.
2. Đo cgroup `cpu.stat`/quota delta, active query/merge/parts và query plans sau
   activity, tránh overhead plan probe trong cửa sổ benchmark. Thu metadata CPU,
   row/byte và query_id, không raw secret hoặc production query text.
3. Admission matched 25→50→150 chỉ sau gate nấc thấp. Giữ timeout 5s/no replay;
   thu auth/session, connection/transaction entry, filter/MVC và JVM/connector
   evidence đồng thời. Ưu tiên vùng residual đã thu hẹp, không tăng Hikari trước.
4. Chỉ chọn runtime/query tuning khi có causal evidence, regression correctness
   (owner isolation, FINAL/version dedup, summary count, freshness, fencing) và
   ba matched before/after. Schema/index vẫn phải qua DESIGN_GATES.

## What the developer should understand before accepting this code

Body timing không phải whole transaction hoặc HTTP duration. P95 không có tính
cộng; muốn phân rã phải dùng cùng correlation và so duration cùng request. Status
0 không nói được commit thất bại; service COMMITTED log cũng chưa thay durable
receipt. Structured metadata và evidence allowlist giúp chẩn đoán mà không log
credential. Một overload được shed có kiểm soát vẫn fail SLO nếu vượt error budget.

Ponytail giữ diff ở harness thay vì speculative runtime tuning; Logging Patterns
đối chiếu correlation và stage boundaries; Encoding Guard kiểm tài liệu UTF-8.
Chưa có matched benchmark mới, EXPLAIN hoặc production timeout root cause.

## Evidence giữ nguyên

- [Admission 150 gốc](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-ad50f00c-e70c-4523-9c69-792cd8012648/admission-150-verified.json)
  và [control timing log](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-ad50f00c-e70c-4523-9c69-792cd8012648/control.log).
- [Admission 25 API-only](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/admission-25-verified.json)
  và [control log](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/control.log).
- [Report query metadata](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-fe28cdf4-8406-4cab-8552-8817dfa29a60/clickhouse-query-metadata.json).
- [Admission 25 sau clone warmup](C:/Users/HP/Desktop/Pet_project/tmp/load/platform-42bc9fa4-7f33-4bc5-8589-9979a872ef66/admission-25-verified.json).

Không ghi đè final/manifest/artifact cũ. Evidence local dưới tmp không thay off-host
backup. Docker chưa khởi động engine trong đợt này; chưa tạo container/network/load
mới và không có cleanup destructive. Production và Windows không bị shutdown.
