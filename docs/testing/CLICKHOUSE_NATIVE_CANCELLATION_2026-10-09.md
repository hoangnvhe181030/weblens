# ClickHouse native cancellation — 2026-10-09

Trạng thái: **local fix verified, NOT DEPLOYED**. Production chỉ đọc metadata;
không đổi quyền/config/schema, không chạy benchmark bằng account operator.
Admission timeout cũ vẫn UNKNOWN; pages chưa có matched-after hoặc proof hết lỗi.

Tiếp nối: [scoped candidate, positive TLS/query-ID và VPS diagnostic](CLICKHOUSE_NATIVE_CANDIDATE_2026-10-09.md).
Đã có 3 cặp handler probe chỉ đọc trên VPS; không phải API full-stack matched-after.
Candidate chưa deploy; Docker local mất engine ở cuối lượt integration bổ sung.

Cập nhật: [phase triage và exact Cloud join](CLICKHOUSE_NATIVE_PHASE_TRIAGE_2026-10-09.md).
Docker đã phục hồi, latest race/integration/cleanup PASS; API gate vẫn FAILED.
Các trạng thái và hashes dưới đây là lịch sử, không phải latest revision.

## Production evidence mới

Operator cung cấp credential và cho phép tự truy cập. HTTPS certificate validation
giữ nguyên; chỉ SELECT với readonly=1, max_execution_time=2s, HTTP timeout6s,
max_result_rows=500/max_result_bytes=262144, result_overflow_mode=throw.
Không đọc query text, exception text hoặc payload. Không GRANT/ALTER/FLUSH LOGS.
Credential dùng trong bộ nhớ công cụ và đã bỏ binding; không ghi vào file/báo cáo.
Operator vẫn nên rotate vì credential đã xuất hiện trong hội thoại.

Server version26.6.1.2326. Catalog cluster default có hai replica;
clusterAllReplicas(default, system.one) trả đủ hai node. Query log Cloud là
node-local nên cần clusterAllReplicas, theo
[tài liệu ClickHouse](https://clickhouse.com/docs/reference/system-tables/query_log).
Đây là topology hiện tại, không chứng minh topology lịch sử không đổi.

Cửa sổ **06:17:41–06:18:45 UTC ngày09/10**, initial_user=weblens_crawler:
6 QueryStart +6 QueryFinish, 6 distinct query IDs, exception_code=0.
Mở rộng ±60s vẫn chỉ có cùng sáu query, không có exception event.

| Class suy từ table metadata, không đọc SQL text | Start UTC | Server duration | Read rows / bytes |
| --- | --- | ---: | --- |
| page metrics | 06:18:23.096178 | 489ms | 60.242 / 9.858.070 |
| findings | 06:18:23.820193 | 190ms | 33.320 / 5.661.282 |
| pages + findings aggregate | 06:18:24.153837 | 188ms | 77.178 / 5.187.174 |
| page metrics | 06:18:26.206792 | 45ms | 60.242 / 9.858.070 |
| findings | 06:18:26.399620 | 34ms | 33.320 / 5.661.282 |
| pages + findings aggregate | 06:18:26.579418 | 50ms | 77.178 / 5.187.174 |

Tất cả row Crawler trên một trong hai node đã đọc. Production app log thiếu
query_id nên chưa nối một-một với request. Class là suy luận theo table set/result
count/thứ tự. normalized_query_hash lưu string tránh mất UInt64 precision.
Recorded settings sáu finish: log_queries=1/log_queries_probability=1;
log_queries_min_query_duration_ms không có entry. Không suy logging settings cho
attempt thiếu record. Network ProfileEvents không phải client RTT.

Kết luận: sáu query được ghi nhận hoàn tất34–489ms, không giải thích trực tiếp
5s phía Crawler. Ưu tiên native acquisition/TLS/Hello hoặc mạng trước execution;
chưa phân biệt Cloud wake-up/network. Không có cơ sở tăng pool/slot, bỏ FINAL/dedup,
thêm cache hoặc sửa SQL để chữa timeout. HTTP metadata access không chứng minh
native endpoint từ VPS ổn định. Không có query record không phải proof tuyệt đối
request chưa tới server. Hai node hiện tại không thay historical coverage proof.

Sanitized artifact:
`tmp/load/recovery-preflight-20261009/pages-query-log-metadata.json`.

## Regression và bản sửa

Flow: report slot → clickhouse-go v2.43.0 acquire → TCP/TLS → native Hello → query.
Source dependency local: default TCP/TLS dial không dùng request context;
Hello đặt deadline theo DialTimeout5s, không theo cancellation còn lại.

Test dùng driver thật với owned loopback peer đọc byte đầu ClientHello rồi
disconnect hoặc im lặng; không mock query response. Pages/summary/page_detail
đều có disconnect, deadline150ms và cancel sau ClientHello.

Trước sửa: **3 pass /6 fail**. Deadline/cancel vẫn chạy quá1s, test đóng peer để
dọn. 1s là detection bound, không phải latency tự nhiên hay benchmark production.

Sửa nhỏ trong openConnection dùng chung read/write/migration:

1. Copy options từng attempt, giữ DefaultDialStrategy và connection/timeout budget.
2. TCP dùng net.Dialer.DialContext; TLS dùng tls.Dialer.DialContext với TLS config
   hiện hữu, giữ certificate/hostname validation và minimum TLS version.
3. context.AfterFunc đóng đúng socket khi acquire/request bị hủy trong Hello;
   handshake lỗi cũng đóng socket; giữ context error chain cho caller.
4. Gỡ callback trước khi trả connection cho pool. Driver cancel acquire context
   khi acquire trả về: callback không được theo connection trong pool.

Không retry query/command, nới timeout hoặc đổi SQL/owner/summary/freshness.
Files: crawler/internal/analytics/{clickhouse.go,clickhouse_test.go,
clickhouse_integration_test.go}; không đổi Java/Capture/frontend production.
Các file có thay đổi cũ: toàn diff so HEAD không phải diff riêng lượt này.

## Kiểm chứng

- Windows focused tests3 lượt: 9 native fault cases/lượt PASS; deadline150–151ms,
  cancel/disconnect khoảng0–2ms theo timer host; report_slots=0/native_open=0.
- TLS untrusted certificate bị từ chối bằng x509.UnknownAuthorityError.
  Không InsecureSkipVerify; chưa chạy positive native TLS integration với Cloud.
- Windows full suite/vet/build PASS; DB integrations thiếu env ở lượt này,
  không dùng lượt Windows làm integration proof.
- Linux Go1.27.1, PostgreSQL17.6-alpine/ClickHouse26.3 thật: full
  go test -race -count=1 -v ./..., vet và build PASS; tám test package pass,
  0 FAIL/SKIP/data-race. Command/migrations/hai tmp probes không có test.
- ClickHouse integration:5 Ping rồi cancel request, connection vẫn reuse,
  Open=0/Idle=1; batch replay/pages/summary/issue filter/detail pass.
  PostgreSQL workflow/heartbeat integration thực sự chạy. Không chạy lại Java/
  Capture vì không đổi; đây không phải chứng minh Windows service Session0.

Evidence: `tmp/load/native-handshake-509541de1c734028967289cb46106420/go-race.log`.
Internal Docker network/no published port, random test credential; source mount
read-only. Runner exit0/OOMKilled=false. Ba UUID-labelled container, anonymous
test data và network đã dọn đúng ownership; module cache/log giữ lại. Không chạm
container/volume dự án khác. Scoped whitespace và UTF-8 checks PASS.

## Acceptance tiếp theo và tác động Java

Local cancellation regression đạt, chưa chứng minh nó gây mọi timeout production.
Tiếp: scoped candidate từ đúng source/binary production, giữ auth patch; staging
native TLS cold/warm ≥3 matched lượt, correlation↔query ID và timing acquisition/
Hello/query-read. API gate p95<1s/failure<1%, tính mọi timeout/429/503; không tăng
5s client timeout hoặc dùng account operator tạo scan/chạy benchmark.

Chỉ canary sau gates, kèm hashes/rollback và clean scoped release. Recovery indexes
vẫn cần API/resource gate. Quyền đọc operator diagnostic đã có; app role không
được cấp thêm quyền. Admission TLS/full-stack, worker kill, full-stack restore,
soak/non-regression còn mở. Không declare complete hoặc lên lịch shutdown.

## What the developer should understand before accepting this code

Java timeout không tự hủy mọi socket bên Crawler. Context phải áp dụng từng blocking
phase; Hello khác query execution. Cancellation callback phải kết thúc cùng
acquisition, không đóng nhầm pooled connection. Server query_duration khác client
query_and_read; thiếu query log khác proof chưa chạy. Java không đổi code/transaction,
chưa có production-after latency proof. Ponytail giữ sửa theo regression, không
dependency mới; Logging Patterns giữ metadata thay secret/query text; Postgres Best
Practices giữ DB test cách ly; Encoding Guard kiểm UTF-8 tài liệu.
