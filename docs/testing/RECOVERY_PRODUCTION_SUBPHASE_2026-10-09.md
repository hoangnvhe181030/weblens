# Production reliability subphase — backup, restore và triage pages

Ngày: 2026-10-09. Quyết định: **BLOCK production index/reliability rollout**.
Đây là báo cáo tiến độ, không phải chứng nhận production-ready hay hoàn tất toàn bộ.
Runbook revision 1 đã được duyệt **có điều kiện**, SHA gốc
`abf1b4b81a22d1286b33cab4bd48517c97ce453af3fcc468b797cb7761151ec7`.
Không bỏ gate API/resources/backup để triển khai. Không tắt máy local hoặc VPS.

Cập nhật tiếp: [native cancellation follow-up](CLICKHOUSE_NATIVE_CANCELLATION_2026-10-09.md)
đã đọc metadata bằng credential operator cung cấp, đủ hai replica hiện tại:
6 query Crawler finish34–489ms, không exception. Đã tái hiện/sửa native handshake
không tuân request cancellation local; race/integration/vet/build PASS.
Chưa deploy hoặc matched-after. Các đoạn thiếu quyền bên dưới là lịch sử lượt đầu,
không còn blocker của lượt đọc operator mới; app role không được cấp thêm quyền.

## Kết quả chính

- Fresh backup ba PostgreSQL: hoàn tất, bản off-host khớp SHA/kích thước, restore
  thật cả ba thành công trên PG 17.11 cô lập; không chạy ứng dụng/worker.
- Rehearsal hai logical index trên dữ liệu thật: 18 statement, coverage 8 leaf
  kể cả default; parent/event/leaf valid/ready/live và đúng key/predicate.
- Read baseline production 1 VU **không đạt**: 4/25 read timeout, đều pages.
  Dừng sau cửa sổ đầu, không tiếp tục ramp hoặc replay; không tạo scan mới.
- Log khoanh vùng pages tới native ClickHouse read path, không chờ application
  slot. Cần server/network evidence để kết luận nguyên nhân sâu hơn.
- Query-log metadata bằng Crawler role trả HTTP 500, exception code **497**.
  Không tự cấp quyền, đổi credential/application role hoặc bật thêm hệ thống.
- Không deploy/push/commit, DDL production, sửa runtime hay applied migrations.
  Production có backup mới, read diagnostics và một login tài khoản benchmark cũ.

## Backup và provenance

Target: `160.191.244.27`, `WIN-D1G2GS3O7J7`; SSH strict pinned host key.
DNS local và VPS của `jobnext.top` đều khớp target. PG 17.11, loopback 5433.
Backup tool hiện hữu đã pin SHA
`1a13355c67577541ad66a9591e8adfd910998ebd513adcb456cc4ecb951175cb`.
Giữ `Global\WebLensDeployment` trong backup; sau exit mutex không còn handle
được quan sát, không dùng mẫu đó để chứng minh critical section tương lai sạch.

| Database | Dump byte | SHA-256 |
| --- | ---: | --- |
| Control Plane | 255.953.491 | `13aa5e3f297bf6ef1f40ff6b2d5b161514098464a01ad34823536efded29a781` |
| Crawler | 715.492.840 | `e50945d767ec545d764da6619fcee6d9ba767f83b5ea561728036071efc7ee73` |
| Capture | 186.805 | `9999b715f4d9532b7a389b60084b52157b5729c1ab626ee9ed519ea88c40f0ad` |

VPS backup dưới `C:\ProgramData\WebLens\backups\recovery-index-20261009-856a91f6c04346cc818afbc17329f105\performance-preflight-20261009T055416Z`.
Off-host/private evidence dưới
`C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105`.
Không đặt dump nhạy cảm vào workspace chỉ vì `tmp/` bị Git ignore.

Root mới trên VPS chỉ Admin/SYSTEM; root local chỉ current user/Admin/SYSTEM.
Kiểm recursive private ACL: không có entry ngoài allowlist. Giữ backup/log gốc.
VPS còn 10.164.445.184 byte sau backup. Budget archive dự kiến 2 GiB được theo dõi
thủ công theo mẫu, **không phải hard cap tự động giữa dump**; floor 5 GiB kiểm sau dump.

Phát hiện bảo mật chưa xử lý rộng:

- Backup root cũ trên VPS cho service accounts đọc backup của service khác.
- Off-host backup cũ dưới `tmp/load/offhost-backups` có inherited Users-group ACL
  gồm quyền đọc. Không thay ACL hay xóa dữ liệu cũ trong subphase này. Cần inventory
  consumer/ownership, lưu ACL hiện hữu và remediation riêng; Git ignore không bảo mật.

## Restore drill và rehearsal

Artifact thành công: `drill-35fb59b9-0a0f-4fd2-8f7a-11ec7d61a4ee` dưới private root.
06:17:34–06:26:08 UTC. Runner/source copy khớp SHA
`840401737215102a02eee821e4271f25ef3bdb160f3bf92b42f35202a4a77eaa`.
Docker image pinned `b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`;
network none, không publish port, dump bind read-only, 2 CPU/1536 MiB, UUID ownership.
`pg_restore --exit-on-error --no-owner --no-acl` vào DB rỗng; không clean DB khác.

| DB | Restore riêng, giây | Table / index / constraint | History entry | Invalid / unvalidated |
| --- | ---: | --- | ---: | --- |
| Control Plane | 83,292 | 11 / 42 / 97 | 13 | 0 / 0 |
| Crawler | 293,930 | 15 / 86 / 187 | 6 | 0 / 0 |
| Capture | 0,544 | 13 / 54 / 97 | 5 | 0 / 0 |

TOC/table names/index names được kiểm; constraint đã validate, index valid/ready/live,
history đọc được; Crawler V1–V6 checksum khớp production preflight và không đổi qua
rehearsal. Không có sequence trong cả archive/catalog; không tuyên bố đã test
sequence không tồn tại. Không làm full per-constraint definition-hash comparison
giữa source/restored; một check bổ sung đến sau khi owned container đã dọn đã dừng
trước SQL vì không tìm thấy đúng container, không dùng làm evidence PASS.

38.667 auth-session row: orphan user, hash không hợp lệ, refresh-hash trùng,
timestamp sai đều 0. Đây là **ledger integrity trong dump**, không chứng minh
stale Redis/backup không làm sống lại session đã logout. Không khởi động auth app.

Lần đầu `drill-6659dc25-0a6d-4319-b9bc-89d22097f9e1`: native restore Control Plane
và Crawler exit 0; post-restore ANALYZE của Crawler lỗi `55P03`, không phải lỗi
archive đã chứng minh. Không có lock snapshot đủ để khẳng định blocker là autovacuum.
Lần sau tắt autovacuum **chỉ ở disposable server**, chạy ANALYZE tường minh và giữ
lock timeout 500 ms; hoàn tất. Lỗi môi trường module path PS7→Windows PowerShell 5
ở ACL preflight cũng đã xử lý trong child environment, không đổi máy/VPS global.
Giữ FAILED evidence; cả hai container/anonymous restored data đã dọn đúng ownership,
không OOM, không chạm container khác. Dump và evidence còn để khôi phục lại drill.

Actual backup: **1.310.477 page / 3.507.106 event**, PERSISTING = 0, DEAD = 0.
Khác fixture synthetic 1.296.711 / 3.499.939 vì fixture dựa trên estimate trước đó.
Không dùng count backup làm proof backlog hiện tại trên production.

Rehearsal DDL SHA `375ef213198365444a1cc5cf5fb4b3fcb1f4df619a3b31ee56148764ad4caa90`:
18 statement serial, 10 physical indexes, tổng 73.728 byte. EXISTS sau index:
PERSISTING false / 0,143 ms, DEAD false / 0,045 ms, selective plans đạt.
Đây là một sample mỗi lookup trên restored snapshot, **không phải p95**.

55 resource samples: WAL insert-LSN delta tổng 46.952 byte; WAL files growth 0;
temp-file sampled peak 0 nhưng cumulative temp_bytes tăng **49.152 byte** — sampling
đã không bắt được ít nhất một temp hoạt động, không được kết luận không dùng temp.
Peak sampled Docker memory khoảng 1.497 MB, CPU 61,96%; không OOM. Memory không
đồng nghĩa RAM tăng thêm cho maintenance; Docker CPU không đổi thành VPS host CPU.
Event build client wall khoảng 3,651 s, populated leaf 0,435/0,645 s, gồm Docker/psql
overhead, không server-only build time. Full per-step evidence giữ trong private root.

Predicate rỗng, không concurrent write, autovacuum tắt, Linux Docker không là Windows
production. Các số này bổ sung **local measurement**, chưa chứng minh production
WAL/temp/peak-memory upper bound hoặc shared-host API non-regression. Không nới gate.
Dump ba DB là ba snapshot độc lập; không có role/ACL/globals, PITR, ClickHouse/R2/
Redis/full-stack restore. Restore durations không phải RTO toàn hệ thống hoặc RPO=0.

## API p95: lỗi thực tế và phần chưa biết

Artifact `api-baseline-ac5da440a183465d999615189f0645e7`, 06:17:41–06:18:28 UTC.
Dùng `api-read.js` hiện hữu, 1 VU, planned 2 × 30 s, timeout 5 s, tài khoản và
website/scan benchmark cũ. 27 request gồm 2 setup; 25 read, 5 attempt/endpoint.
4 read status 0 (16%), đều pages; 20 dashboard/list/progress read và 1 pages trả 200.
k6 exit 99; cửa sổ thứ hai không chạy. Không lấy success-only p95 để che timeout.

| Endpoint | Attempt / lỗi | p95 client, ms |
| --- | --- | ---: |
| dashboard | 5 / 0 | 386,76 |
| websites | 5 / 0 | 877,68 |
| scan list | 5 / 0 | 452,62 |
| scan progress | 5 / 0 | 328,78 |
| pages | 5 / 4 | xấp xỉ 5.000, bị deadline censor |

Sample nhỏ, generator đang cùng host với restore; không so trực tiếp với API p95
1030,47/pages 1692,09 ms ở workload 150 user cũ. Không có matched-after.

Evidence cho lỗi mới:

- Raw k6: 4 page timeout trên reused connection, connect/TLS = 0, waiting ≈5 s,
  receiving = 0. Không phải TLS handshake/connection establishment ở các attempt đó.
- Caddy: 4 page request status 0/zero bytes, duration 5000–5006 ms; 1 page 200/882 ms.
  Status 0 là không có HTTP response hoàn tất, không phải HTTP success/error code 0.
- Crawler: 3 `pages` query/read 5229,910 / 5101,233 / 5111,870 ms rồi
  **`read tcp` / `i/o timeout`**. Application read-slot wait = 0 ms; pool open 1/limit 7.
  Không có bằng chứng cần tăng application slot hoặc thêm cache/broker.
- Lượt thứ tư đi qua Crawler: state read 1,037 ms, page list 5093,481 ms,
  summary 341,760 ms, tổng trước write 5438,651 ms: kết quả đến sau client deadline.
  Lượt thứ năm: state 9,552 ms, page list 372,063 ms, summary 193,860 ms, tổng 575,475 ms.
- Production timing log chưa có `query_id`; slow-page log chưa có correlation ID.
  Local source đã có instrumentation này nhưng không được giả là đã deploy.
  Đối chiếu theo đúng scan/time/operation là khoanh vùng, chưa phải trace chính xác
  native connection acquisition → server query → response cho từng attempt.

**Kết luận:** failure path mới đã khoanh vùng native ClickHouse read/deadline;
network/connection acquisition/server SQL/cold wake-up vẫn chưa tách. Không khẳng
định SQL chậm, native-pool contention, cloud sleep hoặc thiếu recovery index là root
cause. POST admission 146/150 với 4 timeout cũ vẫn UNKNOWN; phase này không gửi POST scan.

Hai lần đọc query-log metadata/aggregate bounded 2 s server/4 s HTTP bằng Crawler
role đều UNVERIFIED/HTTP 500, lần sau có code 497. Mã này biểu thị thiếu quyền theo
[nguồn ClickHouse chính thức](https://clickhouse.com/blog/clickhouse-release-24-02?trk=article-ssr-frontend-pulse_little-text-block).
Không có row không chứng minh query không chạy. Query log Cloud nằm từng node;
cần topology/cluster coverage đúng khi operator xuất metadata, theo
[tài liệu query_log](https://clickhouse.com/docs/reference/system-tables/query_log).
Không tự mở quyền application role hoặc dùng account quản trị để chạy tải.

## Bảo mật công cụ benchmark và kiểm thử

Default k6 summary export chứa `setup_data.token`. Phát hiện một bearer token trong
`round-1-summary.json`; password matches ở baseline files = 0. File chỉ nằm ngoài
repo trong private root, ACL allowlist đạt; không in token trong tool/report/chat,
không upload/push. Token hết hạn 06:32:50 UTC và đã expired khi kiểm. Không tuyên bố
session ledger đã revoke; không có refresh credential được export ở baseline này.
Giữ raw sensitive file riêng để forensic, không đặt link public hoặc coi là sanitized.

Wrapper bỏ `--summary-export`; dùng raw metrics/log để báo cáo.
Wrapper cũng chặn inherited `K6_HTTP_DEBUG`/`K6_SUMMARY_EXPORT` trước request.
Lần đầu parent
PowerShell exit 0 dù k6 exit 99; outcome đã ghi FAILED và không chạy cửa sổ tiếp.
Đã sửa parent exit nonzero khi baseline không đạt. Hai guard mới chỉ kiểm offline,
**chưa replay workload production** vì gate đã thất bại.

- 14/14 offline tests restore/probe PASS, không fail/skip; Node syntax PASS.
- Preflight PowerShell smoke PASS: bounded read-only, timeout/lock UNKNOWN,
  environment/secret guards, sai target bị chặn.
- k6 offline smoke PASS; API wrapper parser/failure/export guards PASS.
- Native restore/rehearsal outcome completed; source snapshot SHA khớp.
- Không chạy lại full Java/Go/Capture suites hoặc review toàn dirty release diff trong
  subphase tooling này. Không dependency mới, không migration/entity mới.
- UTF-8 check 9 file và scoped diff/whitespace check PASS; raw nhạy cảm không vào Git.

Files thuộc continuation này: restore-drill runner/test, API baseline wrapper,
runbook approval status, load README và ba báo cáo/review liên quan được cập nhật.
Preflight/backup wrapper hiện hữu của subphase được dùng lại; không sửa Java/Go/
Capture source hoặc DESIGN_GATES. Dirty workspace có nhiều thay đổi cũ, giữ nguyên;
không coi scoped tooling review là review toàn release.

## Roadmap sau blocker — acceptance, trước/sau và Java Control Plane

| Ưu tiên | Việc tiếp theo / test | Acceptance và benchmark | Tác động Java |
| --- | --- | --- | --- |
| P0 | Operator cung cấp query-log **metadata chỉ đọc** ở 06:17:41–06:18:45 UTC, đúng Crawler role và node coverage; không cần query text/credential. Tách query start/finish/error, duration/read bytes, rồi nối query ID với từng request ở staging | Không thiếu node/permission/provenance; missing vẫn UNKNOWN; không gán server time bằng query_and_read_ms | Xác minh end-to-end deadline và propagation correlation; không tăng timeout/pool để che lỗi |
| P0 | Reproduce pages cold/warm với data/auth/config giữ nguyên ở stack owned; native-dial/receive outage tests, cancel và slot-release checks; dùng timing source hiện hữu | Giữ toàn attempt/timeout/429/503, ≥3 matched lượt; API p95 <1 s, failure <1%; stage timings theo từng request. Chỉ sửa cơ chế đã có proof | Giữ owner authorization, không transaction khi chờ downstream, trả lỗi/freshness đúng; test stale/cancel/deadline |
| P0 | Remediate backup ACL cũ theo inventory/consumer; bảo vệ artifact credentials ở mọi harness có setup_data | Không cross-service/Users-group read ngoài policy; auth compatibility/backup consumers PASS, không xóa evidence | Bảo vệ users/auth_sessions snapshot; không đổi auth runtime/session contract |
| P0 | Sau API containment và production resource/build budget đạt: fresh backup/preflight, mutex + cùng-session advisory lock, approved concurrent DDL, exact inventory/hash record | API không lỗi mới hoặc p95 >baseline 20% ở 2 window; constraints/history/provenance nguyên; full coverage; global proof hai lần 15 s. Không dùng restored false thay production proof | Không Java schema/transaction change; shared-host I/O/WAL phải được theo dõi |
| P1 | Verifier change riêng, test true/false/null/timeout/invalid catalog/thiếu partition; TLS full-stack admission cold/warm × burst/stagger | True ngăn recovered; unknown không false. Admission p95 <1 s/p99 <2 s, <1% failure, từng identity/correlation có COMMITTED và outbox; ≥3 lượt/cell, ramp 25→50→150 | Giữ durable acceptance/idempotency/quota; timeout không replay POST hoặc suy failed commit |
| P1 | Kill/restart worker thật; ClickHouse receipt→PG ACK và object upload→COMMIT faults; full-stack restore/soak | Không mất accepted work, stale lease không publish, no duplicate facts; RPO/RTO/auth logout invariants đã đo; soak/alert owner rõ | Java outbox/inbox/projection reconcile, không distributed transaction |
| P1 | Scoped clean release review/build, backup, canary/rollback auth-compatible, production provenance/health/auth/queue postcheck | Mọi gate PASS và report hoàn tất lưu bền vững; còn UNVERIFIED thì không declare complete | Không release dirty workspace toàn bộ; không mất auth patch hiện chạy |

Không cần xin lại approval hai index. Blocker hiện tại là API gate failed và chưa có
quyền/evidence query log, không phải thiếu đồng ý deploy. Operator có thể xuất chỉ
`query_id`, UTC start/finish, type, query class, duration, read rows/bytes, memory,
exception code của Crawler role trong cửa sổ trên; không gửi token/password/query text.
Nguồn và sanitized summaries ở `tmp/load/recovery-preflight-20261009/`; sensitive raw
ở private root. DDL rehearsal hash không phải approved production execution record.

## What the developer should understand before accepting this code

Backup có hash/TOC khác restore đã chạy; restore PostgreSQL khác phục hồi cả hệ thống.
Partial index đọc nhanh không miễn phí và không sửa Java admission. Deadline timeout
không chứng minh chưa commit hoặc server không hoàn tất. Application slot wait = 0
không loại trừ native acquisition/server/network. Auth ledger integrity khác stale
Redis revocation safety. Ponytail giữ thay đổi trong tooling/evidence; PostgreSQL/
Flyway giữ gates, Logging Patterns giúp redaction/khoanh vùng, Encoding Guard bảo
toàn tài liệu. Chưa hoàn thành mục tiêu: **giữ máy local bật, không tắt VPS**.
