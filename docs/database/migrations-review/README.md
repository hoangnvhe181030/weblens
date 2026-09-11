# Gói migration review cho WebLens V1/V1.5

Trạng thái phát hành: **Người dùng đã duyệt migration để implementation cục bộ;
BLOCK deploy production**.  
Ngày phê duyệt migration review: 2026-09-11.

Schema và migration review đã được phê duyệt ngày 2026-09-11. Control Plane V3–V9
đã được đưa vào runtime Flyway path để kiểm thử cục bộ. Migration Crawler/Capture
chưa được copy sang runtime vì service repository tương ứng chưa tồn tại. Không
deploy production trước khi hoàn tất preflight, benchmark và safety gate trong
tài liệu này.

## Phạm vi và phiên bản đã kiểm tra

- PostgreSQL 17.6; production phải dùng PostgreSQL 17 bản minor còn được hỗ trợ.
- Flyway 11.7.2 lấy từ Spring Boot dependency management hiện tại.
- ClickHouse 26.3 cho syntax/correctness smoke test; image production phải pin
  exact patch hoặc digest sau capacity benchmark.
- Control Plane có migration lịch sử V1/V2 và có thể đã có dữ liệu.
- Crawler PostgreSQL, Capture PostgreSQL và hai logical ClickHouse database được
  xem là database mới khi áp V1/001.

Các thông tin production còn thiếu và có thể thay đổi quyết định release:

- row count, relation/index size và write rate thật của `scans`/`auth_sessions`;
- phiên bản ứng dụng cũ và mới chạy chồng trong rolling deployment;
- lock/statement timeout, replication lag budget và maintenance window;
- backup/PITR đã diễn tập, ClickHouse replication/sharding và recovery runbook;
- kết quả benchmark trong `../V1_V1_5_HYBRID_BENCHMARK_QUERIES.md`.

## Bằng chứng xác minh cục bộ ngày 2026-09-11

- PostgreSQL 17.6: gói review Control/Crawler/Capture đã áp dụng thành công; các
  ca âm về active scan trùng, sai tenant và sai loại object đều bị constraint
  chặn như dự kiến.
- ClickHouse 26.3: hai migration 001 chạy thành công; retry batch, version đến
  sai thứ tự và tombstone giữ đúng một current result theo logical key.
- Spring Boot 3.5.16, Flyway 11.7.2 và Java 21.0.8: Flyway validate và áp dụng đủ
  chín migration Control Plane đến V9 trên PostgreSQL 17.6. V4, V6 và V7 được
  nhận diện là non-transactional.
- Build không chạy integration test đạt 17/17 unit/architecture test và đóng gói
  JAR thành công. Smoke test bổ sung trên cluster PostgreSQL 18.4 tạm thời xác
  nhận hai scan `CANCELLED` cùng website được lưu và truy vấn đúng thứ tự, còn
  active scan thứ hai bị `uq_scans_one_active_per_website` chặn.
- Full integration suite chưa được chạy lại sau khi sửa fixture vì Docker Desktop
  trên máy phát triển dừng do lỗi runtime `dockerInference`; lần chạy trước đó đã
  áp dụng đủ V1–V9 nhưng dừng ở fixture cũ tạo hai scan `QUEUED`. Fixture đã được
  sửa thành hai scan lịch sử `CANCELLED`, compile thành công và được kiểm tra bằng
  smoke test PostgreSQL nêu trên. Đây vẫn là mục xác minh còn mở, không phải bằng
  chứng cho phép deploy production.

## Cấu trúc và ownership

| Thư mục | Owner | Runner dự kiến |
| --- | --- | --- |
| `control-postgresql/` | Spring Boot Control Plane | Flyway của backend sau vòng review |
| `crawler-postgresql/` | Go Crawler Service | Flyway/runner riêng của crawler repository |
| `crawl-clickhouse/` | Go Crawler Service | ClickHouse migration runner riêng |
| `capture-postgresql/` | Playwright Capture Worker | Flyway/runner riêng của capture repository |
| `capture-clickhouse/` | Playwright Capture Worker | ClickHouse migration runner riêng |

Không service nào được trỏ runner vào thư mục của service khác. Runtime role
không sở hữu schema và không có `CREATE`, `ALTER`, `DROP`, superuser hoặc
`BYPASSRLS`; provisioning role tạo database/role, migration owner chạy DDL và
runtime role chỉ nhận đúng DML/SELECT cần thiết ở task triển khai sau.

## Thứ tự Control Plane

1. `V3`: expand cột nullable/constant-default và thêm CHECK `NOT VALID`.
2. `V4`: tạo unique index scope của scan bằng `CONCURRENTLY`.
3. `V5`: attach index thành unique constraint; lock phải lấy được trong 5 giây.
4. `V6`: tạo partial unique index bảo đảm một active scan/website.
5. `V7`: tạo full FK-supporting index cho `auth_sessions.user_id`.
6. `V8`: tạo các bảng mới, index và FK trên bảng đang rỗng.
7. Deploy application dual-compatible ở task runtime riêng.
8. `V9`: validate ba CHECK của V3 sau khi quan sát production.

Các file V4, V6 và V7 dùng sidecar `.sql.conf` với
`executeInTransaction=false`, vì PostgreSQL không cho `CREATE INDEX CONCURRENTLY`
chạy trong transaction block. Nếu migration concurrent thất bại, không chạy
`repair` ngay: kiểm tra `pg_index.indisvalid`, drop đúng invalid index bằng
`DROP INDEX CONCURRENTLY`, rồi mới retry.

Control Plane đặt `spring.flyway.postgresql.transactional-lock=false` để Flyway
dùng session-level advisory lock. Nếu giữ transactional advisory lock mặc định,
transaction snapshot của runner có thể làm `CREATE INDEX CONCURRENTLY` tự chờ.
Session-level advisory lock vẫn tuần tự hóa các Flyway runner cùng database.

Tham chiếu vận hành: [Flyway script configuration](https://documentation.red-gate.com/fd/script-configuration-277578847.html),
[Flyway PostgreSQL transactional lock](https://documentation.red-gate.com/fd/flyway-postgresql-transactional-lock-setting-277579114.html)
và [PostgreSQL 17 CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html).

## Preflight bắt buộc

Chạy trên primary bằng role read-only trước deploy:

```sql
SELECT current_setting('server_version') AS server_version;

SELECT c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint AS estimated_rows
FROM pg_class c
WHERE c.relname IN ('scans', 'auth_sessions');

SELECT requested_by_user_id, website_id, count(*) AS active_count
FROM scans
WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
GROUP BY requested_by_user_id, website_id
HAVING count(*) > 1;

SELECT pid, application_name, state, xact_start, wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = current_database()
  AND xact_start IS NOT NULL
ORDER BY xact_start;
```

Query duplicate phải trả 0 row. Nếu không, dừng release và giải quyết lifecycle
ở application/domain; migration không tự chọn scan nào để hủy.

## Phân loại lock và chi phí

| Bước | Phân loại | Điều kiện an toàn |
| --- | --- | --- |
| V3 `ADD COLUMN` constant default | metadata-only trên PostgreSQL 17, nhưng cần `ACCESS EXCLUSIVE` ngắn | Không có transaction dài; `lock_timeout=5s` |
| V3 CHECK `NOT VALID` | metadata-only; kiểm tra row mới ngay | Application cũ chấp nhận cột mới |
| V4/V6/V7 concurrent index | scan bảng/index build, không chặn DML thông thường | Theo dõi I/O, CPU, replication lag và invalid index |
| V5 attach unique constraint | metadata operation với lock mạnh ngắn | Index V4 valid; `lock_timeout=5s` |
| V8 create table/index | blocking build chỉ trên bảng mới/rỗng | Không có writer trước khi V8 hoàn tất |
| V9 validate CHECK | full scan `scans`, không rewrite | Chạy tách khỏi peak; theo dõi lag/I/O |

Không có `DROP`, rename, destructive backfill hoặc type narrowing. Không sửa V1/V2
đã áp dụng. Các database service mới tạo schema trong transaction; external call,
object upload và ClickHouse insert không nằm trong PostgreSQL transaction.

## Abort, xác minh và roll-forward

Dừng migration khi lock wait vượt 5 giây, replication lag vượt budget vận hành,
disk vượt watermark hoặc latency/error rate ứng dụng vượt SLO. Không kill session
khác tự động từ migration.

Sau mỗi PostgreSQL phase:

```sql
SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
    'ck_scans_analytics_status',
    'ck_scans_analytics_counts',
    'ck_scans_cancellation_time',
    'uq_scans_id_requester'
)
ORDER BY conname;

SELECT indexrelid::regclass AS index_name, indisready, indisvalid
FROM pg_index
WHERE indexrelid::regclass::text IN (
    'uq_scans_one_active_per_website',
    'ix_auth_sessions_user_id'
)
ORDER BY index_name;
```

Recovery là roll-forward: retry phase metadata sau khi lock hết; cleanup invalid
concurrent index theo đúng tên; restore/PITR chỉ dùng khi diễn tập xác nhận cần
phục hồi dữ liệu. Không dùng down migration để giả định rollback an toàn.

Với ClickHouse, xác minh `system.tables`, `system.parts`, row count theo batch,
receipt hash và current view. Retry cùng logical key/version và tombstone phải cho
kết quả hiện hành duy nhất. Không dựa vào background merge để xác nhận exactly-once.

## Partition `scan_pages`

Crawler V2 bootstrap các partition từ 2026-09 đến hết 2027-03 và một default
partition làm alarm. Trước ngày 2027-02-01 phải có migration tạo thêm partition.
`scan_pages_default` phải luôn có 0 row; có dữ liệu trong đó là incident và phải
được drain có kiểm soát trước khi attach partition mới.

## Điều developer cần hiểu trước khi chấp nhận

Schema approval và migration safety approval là hai cổng khác nhau. SQL đúng cú
pháp không chứng minh online-safe: lock queue, bảng lớn, replication lag, mixed
application version và recovery readiness mới quyết định có thể deploy hay không.

Trong lúc tạo migration, safety review đã bổ sung các invariant không làm đổi use
case: composite FK chặn page/bundle/object reference sai tenant hoặc sai loại
object; tổng page-state counter phải khớp `discovered_count`; object count/bytes
không thể vượt policy snapshot. Schema proposal đã được đồng bộ với các hardening này.
