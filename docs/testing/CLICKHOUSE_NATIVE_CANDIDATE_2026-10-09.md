# Native ClickHouse candidate — TLS, trace và VPS read diagnostic

Ngày: 2026-10-09. Trạng thái: **SCOPED CANDIDATE VERIFIED LOCALLY; NOT DEPLOYED**.
Đây là báo cáo tiến độ, không phải báo cáo hoàn tất reliability/production.

Update mới nhất: [native phase triage](CLICKHOUSE_NATIVE_PHASE_TRIAGE_2026-10-09.md).
Docker/race/cleanup đã xác nhận PASS ở revision mới. API baseline vẫn FAILED;
probe trong tài liệu này dùng dataset khác cohort API lỗi, không xác nhận API gate.
Hashes/phạm vi/test/cleanup dưới đây giữ nguyên như evidence lịch sử.

## Phạm vi và provenance

Candidate được tách từ production baseline
`6ade9332e2e4c4df12b304edecad5d756462143f` trong worktree riêng:
`C:\Users\HP\.codex\worktrees\native-clickhouse-candidate\Pet_project`.
Không lấy toàn bộ dirty workspace làm release.

Sáu file Crawler thay đổi, 363 insertions/8 deletions:

- `internal/analytics/clickhouse.go`: native cancellation adapter đã tái hiện ở
  [báo cáo trước](CLICKHOUSE_NATIVE_CANCELLATION_2026-10-09.md).
- `internal/analytics/reports.go`: query UUID riêng mỗi query; correlation metadata.
- `internal/httpapi/server.go`: cùng correlation đã normalize cho response/context/log.
- Ba test file tương ứng: native fault, TLS validation/reuse và trace consistency.

Không đổi Java, Capture, auth, SQL, migration, dependency, timeout hay pool budget.
Không mang local pages deadline 8s hoặc heartbeat/dispatch changes vào candidate.
Giữ DESIGN_GATES và ba deployable. Query-start trace ở DEBUG; INFO vẫn chỉ timing
chậm/cancel, không mặc định log mọi query production. Không ghi SQL text/payload.

Candidate Windows CLI SHA-256:
`187bd11a0ada803f08732d6bf388364f210f72f8812ba2d9bf65bbd4737589ec`.
Scoped patch SHA-256:
`820ed595bf29f133555a336df39ab45385d33ad89b0f88644a77101fd62b0312`.
Source chưa commit/push; binary chưa thay runtime.

## Test local

- Windows focused tests và full suite PASS; full suite có **3 DB integration SKIP**
  vì thiếu env. Không coi lượt Windows là DB integration proof. Vet/build PASS.
- Linux Go 1.27.1 + PG 17.11 + ClickHouse 26.3: full race suite 8 package PASS,
  0 FAIL/SKIP/data race; vet/build và runner exit0/OOM=false đã quan sát ở lượt đầu.
- Positive TLS fixture: 3 pool mới × 3 queries; trusted certificate, hostname
  validation, minimum TLS1.2; pooled connection còn Open=0/Idle=1 sau cancel.
- Lượt test bổ sung gọi `queryID()` trên server thật: server ID khớp query ID
  report trace; correlation giữ nguyên, slot được trả. Cold 9,840–12,585ms;
  warm 2,127–3,308ms. Đây là SELECT nhỏ qua TLS fixture tới local ClickHouse,
  không phải Cloud wake-up, API p95 hay capacity benchmark.
- Native disconnect/deadline/cancel cho pages/summary/detail PASS; deadline150ms
  khoảng150–152ms trên Linux, không giữ report slot/native capacity.
- TLS untrusted certificate bị từ chối. Invalid/empty/oversized correlation được
  normalize; không log input header injection. Response correlation khớp context.
- Whitespace và UTF-8 check sáu source file PASS.

Evidence đầu:
`tmp/load/native-candidate-73382d8ef5964f9d8205279d737461e8/go-race.log`.
Runner/network/anonymous test data đã dọn đúng label, cache/log giữ lại.
Evidence test queryID bổ sung:
`tmp/load/native-candidate-69ad8f12e6934e46928ed6cecd3b2a7c/go-race.log`.
Log có đủ 8 package PASS, không fail/skip/race. **Docker engine mất sau test**:
không thu được exit cuối/vet/build của lượt bổ sung và chưa xác nhận cleanup.
Không đánh đồng log PASS với cleanup PASS. Khi Docker trở lại, chỉ kiểm/dọn
container/network label `weblens.nativecandidate=69ad8f12e6934e46928ed6cecd3b2a7c`;
không chạm container/volume dự án khác.

## VPS: bounded read-only, không thay service

SSH pinned host; kiểm release/binary trước và sau diagnostic:

- Host `WIN-D1G2GS3O7J7`, VPS `160.191.244.27`.
- Crawler hash vẫn `f2cb284df55b646e193812e43df13d928527b61ed6f5db8bc2010b911f3334f4`.
- Backend auth-patch hash vẫn
  `b4fb8ce65d03581540c76b4ac11282f71451202b8469205dfe6f64472b15f6a7`.
- Bốn service Running tại provenance precheck; diagnostic không stop/start service.

Postcheck 13:56:26 UTC: cả bốn service vẫn Running, Backend health/Crawler ready
HTTP200, không còn process probe trong artifact root; disk còn12.025.335.808 byte.
Health200 là snapshot, không thay API latency/error hoặc recovery acceptance.

Diagnostic binaries dùng cùng source probe, build một bản từ baseline archive,
một bản từ candidate. Chỉ nạp năm ClickHouse env vào process memory trên VPS;
credential ứng dụng không copy về local/log. Không dùng operator account để chạy
report. TLS validation giữ nguyên; readonly=1, max_execution_time=2s,
max_rows_to_read=100000, max_result_rows=5000, max_memory_usage=256MiB,
request deadline5s/root40s. Giữ deployment mutex trong bounded run.
Không listener, worker, migration, scan command hoặc write business data.
Artifact root trên VPS chỉ Admin/SYSTEM; giữ evidence và phục hồi process env.

Lượt đầu 13:43:35–13:43:44 UTC: baseline exit1 trước report read; chỉ có
`outcome=failed`, chưa có error category. Wrapper dừng; candidate chưa chạy.
Không loại evidence này hoặc biến nó thành success/SQL timeout đã phân loại.

Probe kết nối riêng 13:47:02–13:47:13 UTC, deadline2s, cả hai bản PASS.
Open+Ping baseline1730,003ms/candidate684,647ms; warm Ping432,250–451,851ms.
Sink.Ping kiểm cả hai pool nên đây không phải một native RTT. Một cặp chạy tuần tự
không chứng minh cải thiện do patch; cũng không phân loại lỗi lượt đầu.

Sau connectivity precondition đó, 3 matched pairs report probe
**13:49:16.254–13:49:36.694 UTC** hoàn tất:

| Variant | Attempt / hợp lệ HTTP200 | Min–max handler, ms | p95 nearest-rank, ms |
| --- | ---: | ---: | ---: |
| Baseline | 9 /9 | 563,330–1639,868 | 1639,868 |
| Candidate | 9 /9 | 585,036–729,941 | 729,941 |

Cả 18 body có cùng SHA-256
`13f09e186e080403f6adfd83760c5b57876504504fb1f68ec728e4910efe04fc`:
20 page, total1000, owner/scan và cursor đúng. Candidate có 27 unique query UUID,
mọi trace correlation nối đúng 9 request. Timing log quan sát admission wait0.
Chưa đọc Cloud query_log để join chính 27 IDs; integration `queryID()` local là
bằng chứng server nhận ID, không thay metadata proof cho Cloud window này.

Giới hạn: fixture PostgreSQL state, token nội bộ synthetic, handler in-process;
không đi qua Java/Caddy/user auth. Baseline luôn chạy trước candidate; Cloud/cache/
network có thể thay đổi. Open Ping làm ấm native pool trước report. p95 của9
sample theo nearest-rank chính là max, không phải ổn định tail. Không gộp lỗi
lượt đầu vào dataset passing hay so trực tiếp với workload150 user cũ.
**Không kết luận patch giảm latency healthy SQL hoặc đã hết timeout production.**

Local artifacts:
`tmp/load/native-vps-probe-8d7ec671c8364a258a90eff979beeb4b/`.
Có failed manifest, open diagnostic, detailed JSONL/manifest, scoped patch/binaries
và `sanitized-summary.json`. VPS giữ dưới
`C:\ProgramData\WebLens\diagnostics\native-read-8d7ec671c8364a258a90eff979beeb4b`.
Không lưu app/operator credential trong artifact.

## Cổng tiếp theo và quyết định

1. Docker trở lại: xác nhận ownership/cleanup, kiểm latest integration runner.
2. Staging full-stack: TCP/TLS/Hello/query-read timing riêng, deadline và native
   receive/dial outage; ≥3 matched lượt cold/warm. Giữ toàn timeout/429/503.
3. API toàn tuyến p95<1s/failure<1%; admission TLS 25→50→150, burst/stagger,
   từng accepted identity có durable commit/outbox, không replay POST mù.
4. Worker kill/restart, downstream ACK faults, full-stack restore, soak và
   backup ACL remediation; recovery-index resource/API gates vẫn giữ nguyên.
5. Clean release review, auth-compatible canary/rollback, fresh backup/provenance,
   postchecks trước báo cáo hoàn tất và shutdown local Windows.

Metadata production cũ34–489ms và lỗi cancellation local là bằng chứng khác nhau.
Root cause bốn POST admission timeout cũ vẫn UNKNOWN. TCP/TLS/Hello/query receive
chưa tách độc lập; chưa chứng minh local bug giải thích mọi timeout đã ghi nhận.
Không nới timeout/pool, thêm cache/infrastructure hoặc triển khai để vượt gate.
Chưa tắt máy local/VPS; Docker cần operator khởi động/sửa lại như lựa chọn trước đó.

## What the developer should understand before accepting this code

Java deadline chỉ bảo vệ đúng khi downstream cancellation đi hết blocking phases.
Callback đóng socket trong Hello phải detach trước pool reuse. Correlation là
request identity; query UUID là identity từng query, không dùng làm metric label.
Local TLS correctness khác Cloud reliability; handler fixture khác API toàn tuyến.
Ordering/cache có thể làm matched sequential sample trông nhanh hơn dù patch chỉ
sửa cancellation. Java Control Plane không đổi code/transaction/session contract;
chưa có production-after API benchmark.

Ponytail giữ candidate nhỏ; Logging Patterns giữ metadata/trace an toàn; Postgres
Best Practices giới hạn DB test vào môi trường cách ly; Encoding Guard kiểm UTF-8.
Không kiểm chứng các cổng còn mở bằng kết quả probe này và không declare complete.
