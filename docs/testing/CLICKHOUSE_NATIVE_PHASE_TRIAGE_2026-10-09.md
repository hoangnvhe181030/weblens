# ClickHouse native phase triage — 2026-10-09

Trạng thái: **LOCAL CANDIDATE VERIFIED; API GATE FAILED; NOT DEPLOYED**.
Đây là báo cáo tiến độ, không phải báo cáo hoàn tất reliability/production.
Tiếp nối [candidate trước](CLICKHOUSE_NATIVE_CANDIDATE_2026-10-09.md).
Các số/hashes/cleanup trong báo cáo trước là lịch sử của revision trước.

## Kết quả và phạm vi

Lỗi cancellation native đã tái hiện và sửa trong candidate. Chưa chứng minh lỗi
này giải thích toàn bộ timeout production. API baseline mới vẫn có 20% lỗi;
handler probe đúng dataset cũng chưa đạt p95<1s. Không dùng test PASS để bỏ gate.

Candidate dựa production commit
`6ade9332e2e4c4df12b304edecad5d756462143f`, worktree riêng
`C:\Users\HP\.codex\worktrees\native-clickhouse-candidate\Pet_project`.
Sáu tracked file, 463 insertions/8 deletions:
analytics clickhouse.go, reports.go, clickhouse_test.go,
clickhouse_integration_test.go; httpapi server.go, server_test.go.
Không lấy dirty main workspace làm release. Không đổi Java/auth/Capture/config,
SQL/migration/schema/dependency, timeout hoặc pool budget.

Latest scoped patch SHA-256:
`7e4793f23b42db4c5268377bb88eaae939fd378598fc84487b114501d0cb7223`.
Windows CLI build SHA-256:
`a8fa01ebafdfcfd6dd6826c9fad0f0af67a665ef591a2e52936deccd50037f26`.
Binary build mới khớp build trước final test-only edit. Chưa commit/push/deploy.

## Regression trước/sau và trace

| Kiểm chứng | Baseline | Candidate |
| --- | --- | --- |
| Native fault matrix: pages/summary/detail × disconnect/deadline/cancel × plaintext/TLS silent peer | 6 PASS /12 FAIL; native child exit1 | 18 PASS /0 FAIL |
| Deadline150ms | Deadline/cancel vượt detection bound1s | Khoảng150–152ms; trả report/native capacity |
| Physical TLS reuse | Không dùng Idle=1 làm bằng chứng vật lý | Ba pool × ba query: cold1 dial, mỗi warm0 dial; server queryID() khớp trace |
| Full Linux race + PG/CH integration | Revision lịch sử riêng | 8 package PASS; 0 FAIL/SKIP/race; vet/build PASS |

Detection bound1s không phải latency tự nhiên của production.
Windows full suite/vet/build PASS nhưng có3 DB integration SKIP; không dùng lượt
Windows thay DB/race proof. Linux runner Go1.27.1, PG17.11-alpine, CH26.3,
exit0/OOM=false. TLS fixture cold14.381–15.691ms, warm3.052–3.445ms:
SELECT nhỏ chứng minh correctness/reuse, không phải Cloud/API capacity.

Trace chỉ có operation, normalized correlation, UUID query và phase/timing:

- `tcp_tls_ms`: TCP/DNS/TLS gộp, không phải đo riêng TLS.
- `native_setup_ms`: client setup/Hello/Addendum/cleanup, không phải pure Hello
  hoặc server SQL execution.
- `dial_ms`, last_phase, secure/success/context_cancelled.

Failure hoặc dial≥250ms ở INFO; fast success ở DEBUG. Không endpoint, raw error,
SQL text, token hoặc crawled payload; UUID không làm metric label.
Cancellation callback detach trước pool reuse, giữ TLS validation.

Docker đã phục hồi theo thao tác của người dùng. Đã xác nhận ownership và dọn
ba container/anonymous volumes/network cũ label
`weblens.nativecandidate=69ad8f12e6934e46928ed6cecd3b2a7c`.
Runner cũ exit0/OOM=false; hai DB exit255/OOM=false sau engine interruption.
Latest runner label `b102d51a953a424fad03d12cca10e95f` cũng đã cleanup;
read-only inventory sau đó không còn container/network label này.
Chỉ xóa fixture có ownership chính xác; giữ cache/evidence, không chạm dữ liệu khác.

Evidence:
`tmp/load/native-phase-b102d51a953a424fad03d12cca10e95f/go-race.log`;
expanded-native-fault-before.log và native-phase-windows-tests.log dưới probe root.
Patch đầy đủ của revision test hiện tại:
`tmp/load/native-vps-probe-8d7ec671c8364a258a90eff979beeb4b/native-phase-latest-candidate.patch`.

## API baseline mới: giữ đủ failures

Cửa sổ **14:08:28.1948972–14:09:09.8492776 UTC**. 1VU, dự kiến hai window30s,
dừng sau window đầu lỗi: 20 read attempts,16 HTTP200,4 pages timeout
(status0/error1050), error rate20%, read/pages p95 khoảng5000ms bị censor bởi
client timeout. k6 exit99, wrapper exit1; window thứ hai không chạy.

Executed script SHA-256:
`08e3d1eb1512adb71ac5a85f120965d790c836e33a9a3ac12ddd5b491f0d8d05`.
Script này chưa có elapsedMs bổ sung sau đó; không backfill wall timing giả.
Harness hiện tại đã thêm unique bounded correlation và opt-in safe attempt trace,
kèm elapsedMs; offline VM smoke/syntax PASS, không retry hoặc tăng timeout.

| Pages correlation | Caddy duration, ms | Crawler query/read, ms |
| --- | ---: | ---: |
| read-1-0-scan_pages-1791554920986 | 5003.4568 | 5230.5571 |
| read-1-1-scan_pages-1791554928514 | 5008.7374 | 5099.7688 |
| read-1-2-scan_pages-1791554936093 | 5002.1371 | 5109.8422 |
| read-1-3-scan_pages-1791554943385 | 4999.2907 | 5122.0601 |

Caddy nối đúng bốn IDs, status0/size0; không coi status0 là HTTP response hoàn tất.
Crawler admission wait0, pool open1/limit7; bốn errors đúng scan là native read
I/O timeout, không phải context deadline. Crawler production thiếu query/correlation
trace mới: hàng Crawler ghép theo cửa sổ/scan/thứ tự, **chưa exact identity join**.
Log contents hiện tại dù LastWriteTime nhìn cũ; không kết luận collector stale.

Private raw API evidence giữ tại
`C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105\api-baseline-40e3758ae56742bc9dd972acb8b41c93`.
Không export k6 setup_data/bearer token hoặc raw Caddy headers.

## Sửa sai dataset và matched probes đúng identity

Probe cũ dùng owner5b3ebdaa-5812-497c-9ee1-59a639e5d023,
scana8608571-473a-47b7-9ab4-b98db57f32aa: không xác nhận cohort API lỗi.
Không dùng candidate p95 cũ729.941ms để tuyên bố API gate đạt.

API cohort thật: ownerffbe196d-eced-4b71-a74a-beced7b96b1d,
scanb51c354f-72a1-49af-8df0-b66d38f7f48e. Bounded read-only PK lookup Crawler PG:
COMPLETED, expected1000/published1000. Không DDL/GRANT hoặc sửa lifecycle.

Ba matched pairs **14:19:00.868–14:19:20.833 UTC**, cùng probe source và app role:

| Variant | Valid HTTP200 | Min–max handler, ms | p95 nearest-rank, ms |
| --- | ---: | ---: | ---: |
| Baseline | 9/9 | 541.631–1404.368 | 1404.368 |
| Candidate | 9/9 | 530.711–1192.891 | 1192.891 |

Tất cả18 body hash
`e714192d5b4b08f3f7cecfb7b9dc1c3b037e3889ac784ba69fdecd1931a89fe1`,
20 items/total1000/owner/scan/cursor đúng. p95 của9 sample chính là max:
**cả hai vẫn không đạt <1s**, không có causal latency improvement claim.
Baseline luôn chạy trước candidate, warm Ping trước reads; cache/network/time
có thể ảnh hưởng. Fixture PG state, handler in-process, không đi Java/Caddy/auth.

Candidate3 native dial success: TCP+TLS97.807–105.882ms,
native setup70.402–77.552ms, total168.209–183.433ms.
Không suy defect pool từ việc findings mở connection thêm.
Một GET tới Crawler production hiện hữu14:20:24–14:20:26 UTC đạt HTTP200,
20 items/total1000; wall1953.309ms gồm PowerShell/client overhead.
Không retry. Đây là tính phụ thuộc thời gian, không proof cache/stale socket root cause.

## Cloud metadata: exact join và giới hạn

Operator HTTPS chỉ đọc, TLS validation nguyên; server budget2s, HTTP6s,
memory256MiB, bounded rows/bytes, overflow throw. Không query/exception text,
FLUSH LOGS, đổi logging setting/quyền hoặc workload business bằng operator.
Credential không ghi artifact; nên rotate vì đã cung cấp trong hội thoại.

- Cửa sổ API lỗi14:08:25–14:09:20 UTC: HTTP200,0 Crawler events.
  Mở rộng14:07:25–14:10:20 vẫn0. Current coverage đọc đủ hai node.
- Cross-check hai windows trên mọi user thấy hệ thống có log; Crawler record
  xuất hiện ở successful probe window. Không quy0 rows thành permission failure.
- Exact27 query UUID candidate: đủ27 QueryStart +27 QueryFinish,
  server duration22–285ms, exception_code0, trên cả hai node.
  Join bằng UUID, không suy từ thứ tự. Ba dial-associated findings finish198/25/24ms.

Đủ metadata chứng minh candidate IDs được Cloud ghi nhận ở successful window.
Không có record ở failing window **không chứng minh request chưa tới/chưa chạy**:
thiếu ID production, logging/lifecycle/topology lịch sử chưa chứng minh đầy đủ.
Current nodes không thay historical topology proof. Query server time không
bằng client query_and_read; không trừ hai clock để suy riêng network latency.

## Java → Go transport bridge

Một fixture loopback cô lập đã nối CrawlerReportClient Java thật với
internal/httpapi.Server Go thật, không dùng PostgreSQL/ClickHouse/Caddy/auth,
không tạo command/scan. Với read timeout500ms và peer giữ report handler chờ:

| Operation | Java elapsed | Go handler observed | Context cancelled | Correlation |
| --- | ---: | ---: | --- | --- |
| page detail | 891ms | 505.710ms | yes | match |
| pages | 575ms | 511.487ms | yes | match |

Các test Go chạy HTTP và HTTPS, manual cancel và client deadline, -race -count=3,
8 cases mỗi lượt, PASS; go vet PASS. Java transport test PASS: peer im lặng
đóng socket khoảng 499–508ms; test slow-drip cho thấy readTimeout=750ms vẫn
hoàn tất khoảng1,895–1,913ms khi mỗi chunk đến trước idle timeout.

Kết luận: timeout Java đã truyền cancellation tới Go handler và native layer có
thể nhận context cancellation; nhưng SimpleClientHttpRequestFactory read timeout
là inactivity timeout, không phải absolute request deadline. Đây là bằng chứng
cơ chế, chưa phải root cause bốn production pages timeout và chưa biện minh đổi
timeout/pool. Nếu cần hard deadline, phải có yêu cầu/benchmark riêng và đánh giá
API contract trước khi sửa.

Java Control Plane unit boundary cũng PASS: CrawlerReportClientTransportTest
3/3 và ScanReportServiceTest 7/7. Authorization transaction commit xảy ra trước
remote Crawler call; remote failure giữ cause và report semaphore được release.
Đây là kiểm chứng local với mock/loopback, không phải bằng chứng Hikari, Redis,
Caddy hay production instance capacity.

Evidence loopback:
tmp/load/http-transport-8f53920d10c448479bb4f0a14146ad0d/; cleanup runner đúng
label đã PASS, container không còn tồn tại. Binary/fixture chỉ dùng local.

Kết luận phân loại: cancellation là lỗi thật đã tái hiện; API timeout là lỗi thật
đang còn; native transport/acquisition trước execution là hướng điều tra ưu tiên;
server SQL chậm gây bốn timeout, Cloud wake-up và stale connection còn UNKNOWN.
Không có cơ sở nới timeout/pool, thêm cache/datastore hoặc bỏ FINAL/dedup.
Root cause bốn POST admission timeout cũ vẫn UNKNOWN, không replay POST mù.

Sanitized evidence/patch/binary:
`tmp/load/native-vps-probe-8d7ec671c8364a258a90eff979beeb4b/`.
Có exact-cloud-query-metadata.json, failed-api-query-log-coverage.json,
exact-round manifests/logs và native-phase-sanitized-summary.json.

## Roadmap còn lại và acceptance

| Ưu tiên | Bước tiếp theo | Acceptance và benchmark | Tác động Java Control Plane |
| --- | --- | --- | --- |
| P0 | Staging đúng source/runtime/auth; native TCP/TLS silent/Hello/read outage, cold/warm ≥3 matched lượt; request↔query IDs | Bounded cancel, slot/socket recovery, physical reuse; không mất trace/failure; trước/sau cùng identity/config | Kiểm deadline propagation qua servlet/client; không giữ transaction khi HTTP |
| P0 | Full-stack read API + admission25→50→150, burst/stagger riêng | API p95<1s/fail<1%; admission p95<1s/p99<2s/fail<1%; tính timeout/429/503, mọi accepted identity có durable scan/outbox, no blind POST replay | Authorization/auth compatibility, quota/idempotency, bulkhead theo số JVM |
| P0 | Backup ACL cũ inventory/remediation; recovery-index resource gate trước DDL đã được duyệt | Không cross-service/Users read ngoài policy; WAL/temp/peak resource và API non-regression được đo; giữ backup/evidence | Bảo vệ auth/session snapshot; không đổi schema/contract mới |
| P1 | Worker kill/restart, receipt→PG ACK, upload→COMMIT faults | Một logical result, no lost accepted work/stale publish; đo replay/backlog/recovery | Outbox/inbox/reconciliation, không distributed transaction |
| P1 | Full-stack restore, soak, alert/runbook ownership | RPO/RTO đo thật; report/hash/owner/logout invariants; no backlog/DEAD tăng không kiểm soát | Session ledger chống resurrection; projection monotonic |
| P1 | Clean release review, canary/rollback và postchecks | Đủ gates, auth patch giữ nguyên, backup/provenance/hash khớp; cuối cùng lưu report rồi mới shutdown local | Không phát hành dirty workspace hoặc mất auth patch |

Production không deploy/DDL/restart trong subphase này; không tạo scan mới.
Read harness tạo một short-lived auth session. Release/Crawler/auth hashes được
probe kiểm trước/sau, không thay runtime. Không tắt máy local hoặc VPS khi gates mở.

## What the developer should understand before accepting this code

Java deadline không tự hủy mọi downstream socket. Native setup không phải server
execution. Callback cancellation phải detach trước connection reuse.
Benchmark phải cùng owner/scan và ghi rõ censor/failure; p95 nhỏ không phải stable
tail. Idle=1 khác physical reuse; correlation request khác UUID từng query.
Exact Cloud join của successful window không chứng minh failed window đã khỏi.

Ponytail giữ candidate nhỏ; Logging Patterns giữ safe metadata;
Encoding Guard kiểm tài liệu UTF-8. Không thêm công nghệ hoặc thay DESIGN_GATES.
