# Recovery monitoring indexes — runbook review, revision 1

Ngày: 2026-10-09. Release decision: **BLOCK cho tới khi đủ mọi preflight gate**.
Người dùng đã trả lời “tiếp tục” cho review revision 1, phê duyệt có điều kiện
bản thực thi và ngân sách của đúng hai index; không cho phép bỏ hoặc nới gate.
SHA-256 bản revision 1 được duyệt trước cập nhật trạng thái:
`abf1b4b81a22d1286b33cab4bd48517c97ce453af3fcc468b797cb7761151ec7`.
Approval không đồng nghĩa preflight PASS hoặc DDL đã thực thi.
Workload/trình tự RED ở [proposal](PERFORMANCE_RECOVERY_MONITORING_REVIEW.md);
không phê duyệt thêm bảng, schema shape, constraint, retention hoặc dependency.
Evidence local ở [benchmark](../testing/RECOVERY_INDEX_BENCHMARK_2026-10-09.md):
candidate/negative checks hoàn tất; baseline DEAD/sau rollback vẫn timeout 2 s.
Không có production non-regression hoặc build WAL/temp budget từ probe này.

## Mục tiêu và giới hạn

- Crawler-owned PostgreSQL 17: `EXISTS(status='PERSISTING')` trên mọi page partition
  và `EXISTS(status='DEAD')` trên event outbox, gồm execution terminal/default.
- Không count toàn bộ lịch sử, không cache/counter thay proof, không sửa status.
- Đây là index cho phép kiểm recovery, không sửa admission Java hoặc API report.
  Không mở workload 150 scan hay deploy bản reliability khi chỉ index đạt.
- Crawler dùng checksum migration runner riêng, mỗi migration trong transaction.
  Không đưa concurrent DDL vào V1–V6, sửa checksum hoặc chuyển runner sang autocommit.

## Cổng trước thực thi

Operator phải ghi một change record bất biến: revision/runbook SHA-256, generated
DDL SHA-256, target/hostname/DB/schema, PostgreSQL version, owner, thời gian, approval,
release/binary hashes, V1–V6 checksums, inventory partition/index và trạng thái từng bước.
Lưu record ngoài schema history; không tạo bảng maintenance mới hoặc fake migration entry.
Future release/restore cần giữ record, đối chiếu index drift và tái áp dụng chỉ theo
runbook đã duyệt. Dump full schema thường chứa index; vẫn phải kiểm restore thực tế.

1. Duyệt runbook revision này cùng ngân sách; không suy rộng approval phạm vi cũ.
2. Đối chiếu đúng VPS/host key và crawler DB/role từ environment được bảo vệ;
   không đưa password vào CLI/log/report. Không sử dụng local probe cho production.
   Kiểm role sở hữu/được phép DDL trên đúng bảng/schema; thiếu quyền thì BLOCK,
   không tự cấp superuser hoặc mở rộng quyền application role.
3. Giữ `Global\WebLensDeployment` từ trước preflight tới khi kết thúc/abort.
   Cùng critical section với deploy/poll, không chỉ quan sát Scheduled Task Running.
   Nếu mutex đang bị giữ hoặc thao tác khác không tuân mutex: dừng, phối hợp operator.
   Trong **cùng session PostgreSQL maintenance**, lấy session advisory lock
   `8381190041` đang được migration runner dùng theo transaction. Dùng
   `pg_try_advisory_lock`, kết quả false thì STOP; không chờ vô hạn. Giữ đến hết
   change và release bằng unlock/đóng session. Khóa này serialize với runner,
   không thay Windows mutex hoặc coordination cho partition jobs không dùng khóa.
4. Fresh backup cả ba PostgreSQL: SHA/TOC/provenance, bản off-host đã kiểm hash,
   restore drill cách ly thành công. PostgreSQL dump không backup ClickHouse/R2;
   recovery/auth ledger của các store đó có checklist riêng trước rollout toàn hệ thống.
5. Không benchmark/crawl mới, release khác, partition maintenance hoặc concurrent
   index build khác; ghi write rate thực và long transaction/lock waits.
   Dừng admission benchmark, không tự xóa/hủy accepted work để làm gate sạch.
6. Inventory actual version, namespace, constraints, index definitions/flags,
   partitions kể cả default. Nếu nested partition/foreign partition/name collision
   hoặc definition khác dự kiến: BLOCK và review lại; không tự đổi key hoặc predicate.
7. Health/auth/ingress và tài nguyên ổn định trong cửa sổ trước thay đổi.
   Global recovery đang UNVERIFIED không cấm riêng maintenance đã duyệt, nhưng
   vẫn cấm mở load mới và không được gọi là recovery sạch.

### Ngân sách revision 1 đã duyệt có điều kiện — không là số đo/SLO production

| Guard | Đề xuất cho change này | Khi không đạt |
| --- | --- | --- |
| Build | Một leaf/event mỗi lần; maintenance_work_mem 64 MiB; không đổi global config | Dừng bước kế tiếp |
| Lock | lock_timeout 500 ms cho mỗi session DDL; metadata statement_timeout 2 s | Ghi SQLSTATE, inspect catalog; không retry loop |
| Build deadline | statement_timeout 180 s mỗi concurrent build; tổng window 30 phút | Abort/inspect invalid; tăng deadline cần review |
| Disk | Còn ít nhất 5 GiB reserve **sau** backup, cộng budget WAL/temp/index đã đo/ước lượng có cơ sở | Thiếu WAL/temp budget là BLOCK; không suy từ index rỗng nhỏ |
| Host | RAM khả dụng ≥1,5 GiB; CPU <80% và memory-used <85% ở 3 mẫu liên tiếp cách 5 s | Không bắt đầu, hoặc cancel build của đúng change nếu vượt guard |
| Traffic | Không lỗi auth/health mới; API error tăng hoặc p95 vượt matched baseline >20% trong 2 cửa sổ 30 s | Abort, giữ traffic evidence; đây là containment guard, không chứng nhận SLO |
| Proof đọc | statement_timeout 2 s; lock_timeout 500 ms; read-only | Timeout/null/error = UNVERIFIED, không false |

Mẫu headroom production cũ không đủ chứng minh guard. Local benchmark chưa đo
peak temp/WAL/disk hoặc tải ghi đồng thời; phải bổ sung budget trước DDL. Không
nới ngưỡng để khớp máy hiện tại. Chưa có matched API baseline/monitoring để áp
containment guard thì cũng BLOCK; không dùng p95 cũ khác workload làm mẫu thay.
Telemetry lấy mỗi 5 s có thể bỏ spike ngắn.
Đọc health/tài nguyên bằng session khác; quan sát `pg_stat_progress_create_index`,
`pg_stat_activity`, `pg_locks`. Nếu cần cancel, xác nhận PID, DB, role và
application_name/change ID; dùng cancel, không terminate session khác.

## Inventory và DDL đã duyệt có điều kiện (chỉ thực thi khi đủ gate)

Các ví dụ giả định namespace `public`, partition một cấp relkind `r`, B-tree
default opclass/order. Nếu catalog khác, chốt lại bản DDL, không đoán.
Mỗi câu DDL là **một top-level autocommit statement riêng** trong cùng session
đã SET timeout; không `BEGIN`, không multi-statement wrapper cho CONCURRENTLY.
Không `IF NOT EXISTS`: tồn tại cùng tên không chứng minh definition đúng.

```sql
SELECT relid::regclass, parentrelid::regclass, isleaf, level
FROM pg_partition_tree('public.scan_pages') ORDER BY level, relid;

SELECT i.indexrelid::regclass, i.indrelid::regclass,
       i.indisvalid, i.indisready, i.indislive, i.indisunique,
       pg_get_indexdef(i.indexrelid), pg_get_expr(i.indpred,i.indrelid)
FROM pg_index i
WHERE i.indrelid IN (SELECT relid FROM pg_partition_tree('public.scan_pages'))
   OR i.indrelid='public.outbox_events'::regclass;
```

Lưu inventory và checksums trước build. So catalog candidate theo tên, table,
method/key/predicate/opclass/order/include và flags, không chỉ `indisvalid`.

```sql
SET application_name='weblens-recovery-index-change-<approved-id>';
SET lock_timeout='500ms';
SET maintenance_work_mem='64MB';
SET statement_timeout='180s';

-- Operator must verify true before proceeding; false means STOP.
SELECT pg_try_advisory_lock(8381190041);

CREATE INDEX CONCURRENTLY ix_outbox_dead_recovery
ON public.outbox_events USING btree(message_id) WHERE status='DEAD';
```

Sau event, đổi statement_timeout 2 s để tạo metadata parent:

```sql
CREATE INDEX ix_scan_pages_persisting_recovery
ON ONLY public.scan_pages USING btree(id) WHERE status='PERSISTING';
```

Parent chưa valid ở bước này là trạng thái trung gian có chủ đích, không phải
deployment thành công. Từ inventory generate danh sách cặp build/attach, review
và hash trước thực thi. Ví dụ cho tháng 9 (các cặp khác phải làm đủ):

```sql
CREATE INDEX CONCURRENTLY scan_pages_2026_09_persisting_recovery
ON public.scan_pages_2026_09 USING btree(id) WHERE status='PERSISTING';

ALTER INDEX public.ix_scan_pages_persisting_recovery
ATTACH PARTITION public.scan_pages_2026_09_persisting_recovery;
```

Build leaf dùng 180 s; attach dùng 2 s; lock 500 ms cho cả hai. Inventory cũ có
`scan_pages_2026_09`, `2026_10`, `2026_11`, `2026_12`, `2027_01`, `2027_02`,
`2027_03`, `scan_pages_default`. Không hardcode inventory cũ để bỏ partition mới.
Tên leaf `<table>_persisting_recovery` ≤63 byte; namespace/tên phải quote an toàn.
Không tự execute SQL generate từ dữ liệu không được kiểm. Không drop bảng/default.

## Resume và crash recovery

| Catalog sau mất kết nối/crash | Hành động |
| --- | --- |
| Tên không tồn tại; không backend build đang chạy | Chạy đúng bước được duyệt |
| Valid/ready/live, definition đúng, leaf chưa attached | Attach sau kiểm parent/table/predicate |
| Valid/ready/live và đã attached đúng | Ghi completed, bỏ qua bước; không build duplicate |
| Invalid leaf/event chưa attached, thuộc change này | Sau xác nhận build đã dừng, concurrent DROP exact index, verify absent, rồi review retry |
| Parent invalid, subset leaf attached đúng | Resume leaf còn thiếu; không tuyên bố proof coverage |
| Definition/ownership/flags khác, index cùng tên có từ trước | BLOCK; không sửa/drop tự động |
| Client timeout nhưng server còn chạy | Quan sát hoặc cancel đúng PID; không chạy bước trùng |

Concurrent failure có thể để index invalid nhưng vẫn tăng chi phí ghi. Inspect
catalog/progress sau mọi lỗi, không giả định rollback toàn bộ change. Không cleanup
index không thuộc record, constraint-backed hoặc đã attached bằng concurrent DROP.

## Acceptance và post-change proof

1. Event và parent valid/ready/live; exact definition như duyệt, nonunique,
   không INCLUDE. Set leaf attached phải bằng **toàn bộ** page partitions hiện tại,
   kể cả default; không có candidate invalid hoặc build session mồ côi.
2. V1–V6 checksums/constraint/quota/ownership không đổi. Không bảng/entity mới.
3. EXPLAIN có giới hạn của hai EXISTS: populated partitions dùng selective index;
   Seq Scan ở leaf thực sự nhỏ có thể hợp lý, không ép enable_seqscan=off.
   Actual query trong read-only session 2 s trả boolean và buffer/time evidence;
   false ở một snapshot không chứng minh consistency vĩnh viễn.
4. Hai mẫu global proof cách 15 s, cùng health/resource/auth/routes/run reconciliation
   đã đạt. True DEAD/PERSISTING là **phát hiện backlog**, không lỗi của index và
   không lý do sửa status/purge. Timeout hoặc source thiếu giữ UNVERIFIED.
5. Verifier hiện vẫn hardcode hai unverifiedChecks. Chỉ thay verifier qua change
   riêng có test: boolean true ngăn recovered; error/null giữ unknown; catalog
   thiếu/invalid không đạt; không dùng count cho DEAD hoặc lịch sử PERSISTING.
   Chưa xóa check trong revision này. Guard synthetic routes vẫn độc lập.
6. Future partition đã kiểm local tự có matching index. Trên production chỉ
   kiểm tại partition maintenance tự nhiên; không tạo partition giả để test.
7. Soak/write/WAL/Java p95 không suy từ isolated SQL. Index release đủ điều kiện
   mở gate kế tiếp, không thay TLS/full-stack/crash/restore/canary validation.

## Rollback (không zero-downtime guarantee)

- Nếu health không suy giảm, ưu tiên giữ valid index và roll-forward phần còn thiếu;
  tránh destructive rollback vì deadline. Index không đổi contract dữ liệu.
- Event/leaf chưa attached: `DROP INDEX CONCURRENTLY public.<exact-owned-index>`
  từng câu ngoài transaction, bounded timeout; verify absent sau mất kết nối.
- **Partitioned parent không hỗ trợ DROP CONCURRENTLY.** Parent DROP thường lấy
  ACCESS EXCLUSIVE trên bảng và kéo theo attached child indexes. Chỉ chạy
  `DROP INDEX public.ix_scan_pages_persisting_recovery` khi đã duyệt rollback,
  drain phối hợp cả reader/writer/partition jobs, kiểm lock wait và 500 ms lock/
  2 s statement timeout. Không CASCADE, không force kill traffic để hoàn tác.
  Nếu timeout: parent vẫn cần inspect; giữ change PARTIAL/BLOCK, lên maintenance window.
- Sau rollback, keep recovery UNVERIFIED; verify history, các index nền cũ và
  dữ liệu/invariants còn nguyên. Không mở workload mới hoặc tắt máy báo hoàn tất.

Nguồn: [PostgreSQL 17 CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html),
[ALTER INDEX](https://www.postgresql.org/docs/17/sql-alterindex.html),
[DROP INDEX](https://www.postgresql.org/docs/17/sql-dropindex.html).

## What the developer should understand before accepting this code

Java transaction/outbox bảo đảm local durable acceptance; index Crawler không làm
distributed transaction, không sửa timeout ở ingress/auth/Hikari. Partial index
giảm phạm vi read nhưng thêm công việc write/WAL. Parent valid là proof catalog,
không proof backlog sạch. Autocommit maintenance phải restartable bằng catalog
và provenance; không được giả thành migration đã chạy. Chưa duyệt/đủ preflight
thì giữ BLOCK và máy local bật, không tắt VPS.
