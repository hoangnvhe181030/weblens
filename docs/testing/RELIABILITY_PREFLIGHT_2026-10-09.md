# Reliability rollout preflight — 2026-10-09

Trạng thái: hoàn tất đợt kiểm chứng local 50/150 và Capture PostgreSQL/MinIO;
phạm vi và runbook recovery revision 1 đã được duyệt có điều kiện;
chưa triển khai bản reliability lên production.
Báo cáo này không phải chứng nhận production-ready hoặc báo cáo hoàn thành.

Cập nhật tiếp: [native cancellation follow-up](CLICKHOUSE_NATIVE_CANCELLATION_2026-10-09.md)
đã đọc metadata operator trên hai replica hiện tại; sáu Crawler query34–489ms.
Lỗi native handshake vượt cancellation/deadline đã tái hiện và sửa local;
full Go race/integration/vet/build PASS. Chưa deploy, chưa có matched-after hoặc
proof hết pages timeout production; admission cũ vẫn UNKNOWN.
Giữ ba deployable, DESIGN_GATES, auth Redis/ledger hiện hữu và dữ liệu người dùng.

Cập nhật subphase index: [benchmark ngày 2026-10-09](RECOVERY_INDEX_BENCHMARK_2026-10-09.md)
đã hoàn tất candidate/functional/negative checks ở volume synthetic đại diện.
Baseline DEAD và proof sau rollback vẫn TIMEOUT 2 s, không false; outcome
COMPLETED_WITH_BASELINE_TIMEOUT. Page p95 70,655→0,392 ms, DEAD candidate
0,063 ms; 9 offline tests PASS. Chi phí ghi page tăng trong assay; không chứng
minh non-regression/production capacity.

Cập nhật tiếp: [production subphase](RECOVERY_PRODUCTION_SUBPHASE_2026-10-09.md)
đã backup/off-host/restore cả ba PostgreSQL và rehearsal trên dữ liệu thật. API
baseline 1 user không đạt: 4/25 read timeout, đều pages; Crawler ghi native
ClickHouse TCP read timeout, không chờ application slot. Query-log metadata trả
HTTP 500/code 497. Chưa đủ matched baseline/production resource budget cho DDL.
Không sửa verifier, runtime hoặc migration; production chỉ backup và đọc chẩn đoán,
cộng login của tài khoản benchmark cũ. Không deploy/index production; chưa tắt máy.

## Docker và kiểm thử tiếp tục

Docker Desktop từng crash trước khi engine khởi động, tại bước Inference manager
không truy cập được socket `dockerInference`. Đây là lỗi prerequisite local,
không phải bằng chứng lỗi WebLens hoặc root cause timeout production.
Người dùng tự sửa Docker; agent không factory reset, xóa WSL/volume hoặc nâng phiên bản.
Sau thông báo đã sửa, engine trả phiên bản 29.5.3.

- 6 test runner admission PASS, không fail/skip.
- k6 offline smoke PASS; không phát request production.
- Run 50 user × 3 lượt hoàn tất từ source snapshot riêng:
  `tmp/load/admission-a6b5e8e0-63e4-422d-a0d9-4ae220f16a39/`.
- Mỗi snapshot phải clean verify và đạt integration evidence gate trước load.
  Mỗi key chỉ gửi một POST, timeout 5s; gate lỗi dừng ramp, không replay hoặc nới timeout.
- Collector host local ghi riêng `host-samples.jsonl`; không đọc service secrets.
  Không cung cấp DB/container telemetry liên tục hoặc tách máy phát tải/máy đích.

Clean verify của run 50 hoàn tất 01:15:11 +07:00: 102 unit + 44 integration test,
0 fail/error/skip; runner đã vượt critical integration evidence gate và khởi động
backend. Source digest giữ nguyên baseline 25:
`a55d17da56b78c175a3edfa77b37b35d3498b19e88256daa4ab5ffac08f083b0`.
JAR mới SHA-256 `8ca9d79e69c6a225fef36f753e32afd4a206f1c9b2a87bbc5981184bacf4149e`.
Source digest khớp không có nghĩa ZIP/JAR build khác thời điểm phải đồng nhất byte;
chưa kiểm reproducible-build bit-for-bit. Snapshot vẫn `releaseEligible=false`.

Đối chiếu auth source với snapshot production 2026-10-05, bỏ khác biệt CRLF/LF:
luồng session/refresh/logout không đổi. Hai file khác là
`InternalServiceAuthenticationFilter.java` (context-path handling) và
`SecurityConfig.java` (matcher/comment); không phải bằng chứng toàn diff đã review.

### Kết quả 50 user × 3

| Lượt | Accepted / committed | Status 0 / unresolved | Elapsed p95 | Elapsed p99 | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | 50 / 50 | 0 / 0 | 273ms | 276,55ms | PASS |
| 2 | 50 / 50 | 0 / 0 | 109,2ms | 115,04ms | PASS |
| 3 | 50 / 50 | 0 / 0 | 116,1ms | 118,02ms | PASS |

Tổng 150/150 attempt accepted và committed, đủ correlation/transaction evidence;
`final.json` outcome PASS, hoàn tất 01:22:16 +07:00. Hai container và dữ liệu
ephemeral đúng ownership đã xóa; không còn container label admission-probe khi
kiểm tra sau run. Không xóa container Docker khác hoặc source/build/evidence.

Collector có 70 mẫu từ 01:13:49 đến 01:22:18 +07:00, gồm một phần clean build
và cả ba lượt admission; CPU host cực đại quan sát 51%, RAM trống cực tiểu
12.364.427.264 byte. Sampling nominal 5s cộng thời gian thu thập; không bảo đảm
bắt được spike ngắn hoặc đo riêng CPU/container PostgreSQL trong Docker/WSL.

Request chậm nhất lượt 1: elapsed 279ms; HTTP filter 272,9765ms, service-call
224,3226ms, body 56,5455ms, completion sau body 2,895ms. Correlation
`fa5410ac-f407-4823-b87b-f56de0775a00` đối chiếu đúng COMMITTED. Chưa tách
connection acquisition/transaction proxy/JVM scheduling: không gán phần chênh
lệch cho SQL, pool hoặc lock. Không trừ percentile của nhiều request để suy ra stage.

### Kết quả 150 user × 3

Run 150 user × 3 lượt hoàn tất:
`tmp/load/admission-d7827119-2bc0-4b6b-a398-ab4945a766bf/`.
Giữ timeout, auth pacing và stop-on-failed-gate như run 50; không fetch target.

| Lượt | Accepted / committed | Status 0 / unresolved | Elapsed p95 | Elapsed p99 | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | 150 / 150 | 0 / 0 | 473,65ms | 488,02ms | PASS |
| 2 | 150 / 150 | 0 / 0 | 320,3ms | 361,71ms | PASS |
| 3 | 150 / 150 | 0 / 0 | 263ms | 268,02ms | PASS |

Tổng 450/450 attempt accepted và committed, đủ identity/correlation/COMMITTED
evidence; mọi k6 exit 0; final outcome PASS, hoàn tất 01:46:24 +07:00.
Source digest vẫn khớp run 25/50. JAR SHA-256 của run 150:
`6c9202a3322ec2cf0611b8502c196d7c9afae6dcc98d724ff4df0768181a77d3`.
Clean verify hoàn tất 01:25:57 +07:00: 102 unit + 44 integration test,
0 fail/error/skip; critical IT gate PASS. Không có thay đổi backend giữa các run.

187 host sample từ 01:24:02 đến 01:46:26 +07:00, bao phủ phần cuối build và
cả ba lượt admission; CPU host cực đại quan sát 65%, RAM trống cực tiểu
13.344.727.040 byte. Không phải CPU riêng admission hoặc DB; cùng giới hạn sampling
như run 50. Hai container/data ephemeral đúng ownership đã xóa, evidence giữ lại;
không còn container admission-probe khi kiểm sau run.

Request chậm nhất lượt 1 mất 491ms; filter 488,8444ms, service-call 400,1674ms,
body 23,8751ms, completion sau body 3,7074ms. Correlation
`a7ef0b99-c3e0-4453-8196-966ddd17fca9` có COMMITTED. Khoảng chờ ngoài body vẫn
chưa tách theo connection acquisition/auth/JVM/proxy; không dùng nó để kết luận
root cause. Không gộp percentile các lượt thành percentile chung.

Trong phiên này, 50 × 3 và 150 × 3 có tổng 600 attempt thành công; cộng baseline
25 × 3 là 675 attempt qua các run độc lập, không phải một workload 675 user đồng thời.
Không có matched production-before/after hoặc chứng minh error budget dài hạn.

Baseline 25 × 3 ngày 2026-10-08: 75/75 accepted và committed, không status 0/unresolved;
elapsed p95 từng lượt 344,8 / 91,6 / 81,8ms. Chi tiết và provenance ở
[local baseline](LOCAL_ADMISSION_BASELINE_2026-10-08.md).
Không coi các lượt warm-up là benchmark trước/sau sửa code.

## Capture PostgreSQL/MinIO đã chạy lại

Artifact: `tmp/load/capture-check-42885038-fdda-46f6-ba9e-3d3962788fc3/`, gồm
`tests.stdout.log` và `tests.stderr.log`. Chạy sau khi load kết thúc để tránh
chủ động gây nhiễu admission trên cùng máy.

- Full suite 66 test: 60 pass, 0 fail/cancelled, 6 browser smoke skip rõ ràng;
  duration 12.306,3133ms. Stderr trống. Typecheck `tsc --noEmit` PASS.
- Ba PostgreSQL integration và một MinIO integration đều chạy, không skip.
  Có duplicate command/fencing/analytical completion, site-clone invariants và
  heartbeat expiry sau unchanged row-lock wait; MinIO put/copy/hash/read/delete.
- PostgreSQL 17.6-alpine image ID
  `sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`.
- MinIO pinned image ID
  `sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e`.
- Endpoint chỉ bind loopback, credential/bucket riêng ngẫu nhiên, mỗi container
  có label ownership UUID. Không dùng environment/credential production.
- Hash của Capture src/migrations không đổi trong lúc test. Hai container và
  dữ liệu test riêng đã xóa; kiểm lại không còn label của run; log giữ nguyên.

Browser smoke chủ động tắt, không tải/nâng browser hoặc mở cửa sổ. Chưa kiểm
Windows service Session 0, kill worker thật, ambiguous COMMIT với object storage
thật, ClickHouse ACK window hoặc restore toàn hệ thống trong đợt này.

## Production preflight chỉ đọc

Các quan sát dưới đây được lấy trước lượt load mới, không phải telemetry liên tục.
Không deploy, push, sửa environment, thay service, chạy migration hoặc load production.

- Target đã đối chiếu: `jobnext.top`, VPS `160.191.244.27`, hostname `WIN-D1G2GS3O7J7`;
  SSH dùng host key đã pin.
- Backend, Crawler, Capture, Caddy và PostgreSQL đều Running tại thời điểm kiểm tra.
- Health loopback kiểm lại bằng curl không proxy: Backend 200;
  Crawler live 200 / ready 200; Capture live 200 / ready 200.
  Lần Invoke-WebRequest không xác minh được không được diễn giải là worker unhealthy.
- Release nền: `6ade9332e2e4c4df12b304edecad5d756462143f`.
  Backend thực tế SHA-256:
  `b4fb8ce65d03581540c76b4ac11282f71451202b8469205dfe6f64472b15f6a7`;
  khớp Redis auth patch 2026-10-05, không chỉ public release manifest.
- Crawler SHA-256:
  `f2cb284df55b646e193812e43df13d928527b61ed6f5db8bc2010b911f3334f4`.
- RAM khả dụng 1.603.776KiB; disk trống 11.684.495.360 byte: chỉ một mẫu,
  không chứng minh đủ headroom cho release, backup hoặc load.
- DeployPoll LastTaskResult 0; trạng thái Running không chứng minh mutex đang bị giữ.
  Mọi mutation về sau phải kiểm lại và serialize bằng `Global\WebLensDeployment`.

Không đọc/in credential. Redis production TLS và hai timeout 10s phải giữ nguyên;
Redis local không TLS/timeout 1s không phải môi trường tương đương production.

### Đối chiếu recovery plan mới, 01:25:50 +07:00

Chỉ chạy `EXPLAIN (FORMAT JSON)` của hai SELECT EXISTS và đọc catalog;
statement timeout 2s, lock timeout 500ms, default transaction read-only.
Không dùng ANALYZE, không thực thi quét dữ liệu và không thay schema/index/stats.

- Lookup PERSISTING: Append gồm Seq Scan trên 8 partition, bao gồm default.
- Lookup event DEAD: Gather + Seq Scan trên outbox_events, không có index lookup.
- Catalog outbox estimate 3.499.939 row, total relation size 4.302.225.408 byte.
- Partition tháng 9 estimate 516.071 row / total 457.097.216 byte;
  tháng 10 estimate 780.640 row / total 695.148.544 byte.
- Sáu partition còn lại estimate 0, mỗi total 65.536 byte; không chứng minh rỗng.
  Estimate của parent không cộng thay estimate partition.

`total relation size` gồm heap/index/TOAST; không so trực tiếp với heap-only trong
snapshot cũ. Plan row estimate không phải actual DEAD/PERSISTING count; chưa có
execution latency/buffer proof mới. Kết quả xác nhận query path vẫn không chọn lọc,
không xác nhận recovery hoặc quy admission timeout cho các lookup này.
Số liệu volume mới cần đưa vào runbook/benchmark index nếu scope được review.

## Gate còn lại trước rollout

1. Admission local 50 × 3, rồi 150 × 3 nếu đạt: p95 < 1s, p99 < 2s,
   failure < 1%, mọi identity đối chiếu scan/outbox/COMMITTED và correlation đầy đủ.
2. Review diff dự định release trong checkout riêng; không commit toàn workspace dirty.
   Giữ auth patch đang chạy, migration checksum và runtime/browser guards.
3. Full-stack staging với ingress/TLS và fixture được sở hữu; matrix cold/warm ×
   burst/stagger, ít nhất ba lượt/cell; telemetry hai phía và correlation từng request.
4. API baseline/candidate cùng workload, data và cấu hình auth; giữ 429/503/timeout
   trong báo cáo, không lấy p95 của request thành công thay toàn bộ attempt.
5. Đo predecessor/heartbeat query cost trên volume đại diện, EXPLAIN có giới hạn.
   Không thêm index khi chưa có bằng chứng và review đúng DESIGN_GATES.
6. Kill/restart worker thật, downstream outage/slow response, ClickHouse receipt →
   PostgreSQL ACK và object upload → COMMIT; không mất command/result, stale lease
   không publish. Java sender với durable fixture chưa thay thế các phép thử này.
7. Restore vào stack cách ly: PostgreSQL + analytical facts + object/auth invariants;
   đo RPO/RTO, hash/TOC backup không thay restore drill. Soak và runbook/alert ownership.
8. Clean build/release, backup mới, rollback tương thích auth, canary có containment;
   kiểm health/auth/queue/provenance sau deploy, rồi lưu báo cáo hoàn thành.

Recovery toàn cục PERSISTING ngoài active execution và Crawler event DEAD vẫn
UNVERIFIED theo [review revision 1](../database/PERFORMANCE_RECOVERY_MONITORING_REVIEW.md).
Không bỏ hai check hoặc chạy harness cũ có hash/commit không khớp.

Tại lần chốt báo cáo gốc chưa nhận phản hồi review riêng **phạm vi hai index logic**.
Cập nhật: người dùng đã duyệt phạm vi ngày 2026-10-09; thử index local và
[runbook review](../database/RECOVERY_INDEX_RUNBOOK.md) là bước tiếp theo.
Đây chỉ là bước thiết kế/kiểm thử,
không cấp quyền chạy DDL production. Runbook, ngân sách tài nguyên, measurement
trước/sau và rollback vẫn phải review trước mutation. Các gate staging/crash/
restore/soak/release ở trên cũng chưa hoàn tất, kể cả khi scope index được duyệt.

## Root cause và giới hạn

Admission production cũ 146/150 accepted, 4 timeout 5s; API p95 cũ 1030,47ms và
pages 1692,09ms chưa có matched-after baseline. Root cause vẫn UNKNOWN.
Local admission-only thành công không loại trừ TLS/ingress/generator/contention
full-stack; không quy timeout cho SQL, Redis hoặc JVM khi chưa có trace.

Ponytail giữ thay đổi hiện tại ở evidence, không thêm dependency/hạ tầng/schema.
Vietnamese Encoding Guard được dùng cho báo cáo tiếng Việt; UTF-8 check PASS,
không cần sửa encoding. Phiên tiếp tục này chỉ thêm báo cáo, chạy tooling/test
hiện hữu; không sửa runtime source, dependency, migration hoặc config production.

## What the developer should understand before accepting this code

- HTTP accepted, durable commit và workflow/report hoàn tất là ba bằng chứng riêng.
- Source snapshot/hash định danh phép đo; workspace dirty chưa là nguồn release đã review.
- Restore Redis cũ không được hồi sinh session đã revoke trong PostgreSQL;
  rollback JWT-only hoặc restore auth ledger cần invalidation riêng.
- Yêu cầu tắt máy chỉ áp dụng local Windows sau hoàn thành và lưu báo cáo;
  chưa đạt điều kiện, chưa lên lịch shutdown; không tắt VPS production.
