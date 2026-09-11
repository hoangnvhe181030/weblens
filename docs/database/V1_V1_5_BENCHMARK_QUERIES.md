# Truy vấn benchmark cho schema V1 và V1.5

> **Trạng thái: tạm dừng sau ADR-005/ADR-006.** Dataset và truy vấn dưới đây được viết cho
> schema một database owner. Chúng chỉ được dùng làm dữ liệu đầu vào khi tách lại
> benchmark suite cho Control Plane, Crawler Service, Capture Worker và ClickHouse
> analytics. Không chạy để phê duyệt schema mới cho đến khi ownership, contract và
> DDL từng datastore được review lại.
> Bản thay thế hiện hành là
> [benchmark hybrid](V1_V1_5_HYBRID_BENCHMARK_QUERIES.md).

Trạng thái: bản benchmark đi kèm
[đề xuất schema](V1_V1_5_SCHEMA_PROPOSAL.md), chưa phải test đã chạy. Chỉ chạy
sau khi schema review được phê duyệt và có migration thử nghiệm riêng. Mọi kết
quả phải ghi cấu hình máy, PostgreSQL, PgBouncer, pool, dataset, cache state và
thời lượng test; không dùng database rỗng để tuyên bố production-ready.

## 1. Dataset chuẩn

| Bảng | Cardinality baseline |
| --- | ---: |
| `users` | 100.000 |
| `auth_sessions` active | 200.000–500.000 |
| `websites` | 300.000 — giả thuyết chờ duyệt |
| `scans` giữ 365 ngày | khoảng 7,3 triệu |
| `scan_pages` giữ 180 ngày | khoảng 108 triệu |
| `page_metrics` giữ 180 ngày | tối đa khoảng 108 triệu |
| `findings` giữ 180 ngày | khoảng 216 triệu theo giả thuyết 2/page |
| `capture_jobs` giữ 365 ngày | khoảng 6,3 triệu nếu duy trì 0,2/giây liên tục |
| `page_snapshots` giữ 180 ngày | khoảng 3,1 triệu |
| `network_requests` giữ 180 ngày | khoảng 311 triệu theo giả thuyết 100/capture |
| `captured_resources` giữ 180 ngày | khoảng 62 triệu theo giả thuyết 20/capture |

Phân bố phải có owner lệch: owner lớn nhất 5% tải ở bài chuẩn và 20% ở bài noisy
tenant. Ít nhất 10% scan đạt p95 80 page; không để mọi scan có cùng cardinality.
URL, MIME type, status, failure, finding severity và capture size phải có phân bố
gần production, kể cả URL dài và row không có metric.

## 2. Cách đo

Mỗi truy vấn phải chạy cả cache lạnh có kiểm soát và cache ấm, dùng parameter
distribution thực, không luôn lookup một row đang nằm trong cache. Lưu:

```sql
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, VERBOSE)
-- truy vấn cần đo;
```

Theo dõi đồng thời:

- p50/p95/p99 latency và throughput;
- pool wait, connection sử dụng, transaction duration;
- rows examined/returned, shared hit/read/dirtied;
- WAL bytes, checkpoint, disk latency và queue depth;
- row-lock wait, deadlock, serialization retry;
- dead tuple, autovacuum duration và index/table bloat;
- partition pruning và kích thước từng partition/index.

Query point/list/queue không được seq-scan toàn parent table. Một seq scan nhỏ bên
trong đúng partition có thể hợp lệ nếu cost thấp và được giải thích bằng plan.

## 3. Control-plane query

### Q1 — Đăng nhập bằng normalized email

```sql
SELECT id, password_hash, status, version
FROM users
WHERE normalized_email = $1;
```

Kỳ vọng unique index lookup, tối đa một row, không scan theo `lower(email)` tại
runtime vì normalized value đã được tính trước.

### Q2 — Rotate/revoke refresh session

```sql
SELECT id, user_id, refresh_jti_hash, csrf_token_hash,
       expires_at, revoked_at, version
FROM auth_sessions
WHERE id = $1
FOR UPDATE;
```

Benchmark hai request cạnh tranh cùng session. Chỉ một request được rotate thành
công; request còn lại phải quan sát token cũ không còn hợp lệ, không sinh hai
refresh token hợp lệ.

### Q3 — Danh sách website bằng keyset cursor

```sql
SELECT id, display_name, canonical_url, hostname, status, updated_at
FROM websites
WHERE owner_id = $1
  AND status = 'ACTIVE'
  AND (updated_at < $2 OR (updated_at = $2 AND id > $3))
ORDER BY updated_at DESC, id ASC
LIMIT $4;
```

Cursor đầu trang bỏ predicate cursor. Chỉ số `$4` mặc định 50, tối đa 100. Điều
kiện tách `updated_at`/`id` phản ánh đúng mixed sort direction của index hiện tại.

### Q4 — Đọc progress có ownership

```sql
SELECT id, status, discovered_count, queued_count, processed_count,
       succeeded_count, failed_count, skipped_count, cancelled_count, max_pages,
       progress_revision, progress_calculated_at, updated_at
FROM scans
WHERE id = $1
  AND requested_by_user_id = $2;
```

Mục tiêu end-to-end p95 dưới 200 ms ở polling 5 giây có jitter. Response phải
cho frontend biết `progress_calculated_at` để không giả vờ projection là realtime.

### Q5 — Lịch sử scan

```sql
SELECT id, website_id, status, processed_count, succeeded_count,
       failed_count, created_at, started_at, finished_at
FROM scans
WHERE requested_by_user_id = $1
  AND website_id = $2
  AND (created_at, id) < ($3, $4)
ORDER BY created_at DESC, id DESC
LIMIT $5;
```

Mục tiêu report p95 dưới 500 ms ở cursor sâu và owner lệch 5%/20%.

## 4. Scan/page data-plane query

### Q6 — Claim scan atomically

```sql
WITH candidate AS (
    SELECT id
    FROM scans
    WHERE status = 'QUEUED'
      AND available_at <= clock_timestamp()
    ORDER BY queue_priority DESC, available_at, created_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE scans AS s
SET status = 'RUNNING',
    attempt_count = s.attempt_count + 1,
    lease_owner = $2,
    lease_generation = s.lease_generation + 1,
    lease_expires_at = clock_timestamp() + interval '30 seconds',
    started_at = COALESCE(s.started_at, clock_timestamp()),
    updated_at = clock_timestamp()
FROM candidate AS c
WHERE s.id = c.id
  AND s.attempt_count < 3
RETURNING s.id, s.website_id, s.lease_generation;
```

Chạy 100–300 worker cạnh tranh. Một scan chỉ được trả cho một owner/generation;
không lock convoy và không bỏ đói owner nhỏ trong workload fairness.

### Q7 — Claim page trong một scan

```sql
WITH candidate AS (
    SELECT scan_id, id
    FROM scan_pages
    WHERE scan_id = $1
      AND status = 'QUEUED'
      AND available_at <= clock_timestamp()
    ORDER BY queue_priority DESC, available_at, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
UPDATE scan_pages AS p
SET status = 'RUNNING',
    attempt_count = p.attempt_count + 1,
    lease_owner = $3,
    lease_generation = p.lease_generation + 1,
    lease_expires_at = clock_timestamp() + interval '30 seconds',
    started_at = COALESCE(p.started_at, clock_timestamp()),
    updated_at = clock_timestamp()
FROM candidate AS c
WHERE p.scan_id = c.scan_id
  AND p.id = c.id
  AND p.attempt_count < 3
RETURNING p.scan_id, p.id, p.normalized_url,
          p.lease_generation, p.attempt_count;
```

Kỳ vọng partition pruning đúng một partition và không hai worker nhận cùng
`(scan_id, id, lease_generation)`.

### Q8 — Commit page outcome có fencing và cancellation gate

```sql
UPDATE scan_pages AS p
SET status = $6,
    final_url = $7,
    final_url_hash = $8,
    http_status = $9,
    response_bytes = $10,
    error_code = $11,
    error_message = $12,
    lease_owner = NULL,
    lease_expires_at = NULL,
    finished_at = clock_timestamp(),
    updated_at = clock_timestamp()
FROM scans AS s
WHERE p.scan_id = $1
  AND p.id = $2
  AND p.lease_owner = $3
  AND p.lease_generation = $4
  AND p.status = 'RUNNING'
  AND s.id = p.scan_id
  AND s.status = 'RUNNING'
  AND $5 = p.attempt_count
RETURNING p.scan_id, p.id;
```

Metric và findings tương ứng được insert trong cùng transaction khi UPDATE trả
một row. `UPDATE 0` là duplicate/stale/cancelled result và không được retry như
một completion mới.

### Q9 — Reconcile progress projection

```sql
WITH actual AS (
    SELECT scan_id,
           count(*) AS discovered_count,
           count(*) FILTER (WHERE status = 'QUEUED') AS queued_count,
           count(*) FILTER (
               WHERE status IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')
           ) AS processed_count,
           count(*) FILTER (WHERE status = 'SUCCEEDED') AS succeeded_count,
           count(*) FILTER (WHERE status = 'FAILED') AS failed_count,
           count(*) FILTER (WHERE status = 'SKIPPED') AS skipped_count,
           count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled_count
    FROM scan_pages
    WHERE scan_id = $1
    GROUP BY scan_id
)
UPDATE scans AS s
SET discovered_count = a.discovered_count,
    queued_count = a.queued_count,
    processed_count = a.processed_count,
    succeeded_count = a.succeeded_count,
    failed_count = a.failed_count,
    skipped_count = a.skipped_count,
    cancelled_count = a.cancelled_count,
    progress_revision = s.progress_revision + 1,
    progress_calculated_at = clock_timestamp(),
    updated_at = clock_timestamp()
FROM actual AS a
WHERE s.id = a.scan_id
  AND s.status IN ('RUNNING', 'CANCEL_REQUESTED')
RETURNING s.id, s.progress_revision;
```

Mỗi scan tối đa 100 page nên aggregate phải nhỏ. Chạy projector tối đa một lần
mỗi 2 giây/scan, coalesce nhiều completion và không chạy đồng thời hai projector
cho cùng scan.

### Q10 — Page report bằng cursor

```sql
SELECT p.id, p.normalized_url, p.final_url, p.depth, p.status,
       p.http_status, p.response_bytes, p.error_code,
       m.collection_status, m.ttfb_us, m.total_us,
       m.transferred_bytes, m.dom_nodes
FROM scan_pages AS p
LEFT JOIN page_metrics AS m
  ON m.scan_id = p.scan_id
 AND m.scan_page_id = p.id
 AND m.metric_schema_version = $3
WHERE p.scan_id = $1
  AND ($2::varchar IS NULL OR p.status = $2)
  AND p.id > $4
ORDER BY p.id
LIMIT $5;
```

Tách query không filter và query có filter khi triển khai để planner dùng partial/
composite index ổn định; biểu thức optional parameter ở trên chỉ mô tả contract.

### Q11 — Findings của scan

```sql
SELECT id, scan_page_id, rule_code, rule_version, finding_key,
       category, severity, title, message, evidence
FROM findings
WHERE scan_id = $1
  AND severity = ANY($2::varchar[])
  AND id > $3
ORDER BY id
LIMIT $4;
```

Benchmark response có evidence gần 16 KiB để phát hiện heap read/toast cost, không
chỉ dùng `{}`.

## 5. Capture data-plane query

### Q12 — Claim capture job

```sql
WITH candidate AS (
    SELECT id
    FROM capture_jobs
    WHERE status = 'QUEUED'
      AND available_at <= clock_timestamp()
    ORDER BY queue_priority DESC, available_at, created_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE capture_jobs AS j
SET status = 'RUNNING',
    attempt_count = j.attempt_count + 1,
    lease_owner = $2,
    lease_generation = j.lease_generation + 1,
    lease_expires_at = clock_timestamp() + interval '60 seconds',
    started_at = COALESCE(j.started_at, clock_timestamp()),
    updated_at = clock_timestamp()
FROM candidate AS c
WHERE j.id = c.id
  AND j.attempt_count < 3
RETURNING j.id, j.owner_id, j.scan_id, j.scan_page_id, j.requested_url,
          j.lease_generation;
```

Chạy ở 10 worker bình thường và burst 2 capture/giây. Background pool không được
làm tăng p95 control plane vượt SLO.

### Q13 — Dedup object trong cùng owner

```sql
INSERT INTO capture_objects (
    owner_id, id, sha256, byte_length, content_type,
    storage_bucket, storage_key, storage_etag,
    state, created_at, last_verified_at, delete_after
)
VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8,
    'AVAILABLE', clock_timestamp(), clock_timestamp(), $9
)
ON CONFLICT (owner_id, sha256, byte_length)
DO UPDATE SET
    state = 'AVAILABLE',
    storage_bucket = EXCLUDED.storage_bucket,
    storage_key = EXCLUDED.storage_key,
    storage_etag = EXCLUDED.storage_etag,
    last_verified_at = EXCLUDED.last_verified_at,
    delete_after = GREATEST(capture_objects.delete_after, EXCLUDED.delete_after)
WHERE capture_objects.state IN ('AVAILABLE', 'MISSING')
RETURNING id, storage_bucket, storage_key, state;
```

Hai worker cùng hash phải nhận cùng object logical. Nếu row đang
`DELETE_PENDING`, statement không trả row và worker phải retry sau khi GC kết
thúc; không được tạo reference mới tới object đang bị xóa.

### Q14 — Snapshot detail đã authorize

```sql
SELECT s.id, s.status, s.final_url, s.page_title,
       s.html_object_id, s.screenshot_object_id,
       s.browser_name, s.browser_version, s.collector_version, s.captured_at
FROM page_snapshots AS s
WHERE s.id = $1
  AND s.owner_id = $2;
```

Sau query này service mới tạo presigned URL; không lưu presigned URL trong DB.

### Q15 — Network/resource inspection

```sql
SELECT n.id, n.sequence_no, n.method, n.request_url,
       n.resource_type, n.status_code, n.mime_type,
       n.duration_ms, n.transferred_bytes, n.error_code,
       n.capture_decision, r.object_id
FROM network_requests AS n
LEFT JOIN captured_resources AS r
  ON r.snapshot_id = n.snapshot_id
 AND r.network_request_id = n.id
WHERE n.snapshot_id = $1
  AND n.resource_type = ANY($2::varchar[])
  AND n.sequence_no > $3
ORDER BY n.sequence_no
LIMIT $4;
```

Kỳ vọng prune đúng partition, cursor tối đa 100 và không N+1 lookup object.

## 6. Retention và garbage collection

### Q16 — Chọn scan cần purge detail

```sql
SELECT id
FROM scans
WHERE detail_purged_at IS NULL
  AND detail_expires_at <= clock_timestamp()
ORDER BY detail_expires_at, id
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

Mỗi scan được purge trong transaction riêng hoặc xóa page theo batch 1.000–5.000
row. Đo WAL, replica lag, dead tuple và ảnh hưởng report trong lúc purge.

### Q17 — Chọn object không còn reference

```sql
SELECT o.owner_id, o.id, o.storage_bucket, o.storage_key
FROM capture_objects AS o
WHERE o.state IN ('AVAILABLE', 'MISSING')
  AND o.delete_after <= clock_timestamp()
  AND NOT EXISTS (
      SELECT 1
      FROM page_snapshots AS s
      WHERE s.owner_id = o.owner_id
        AND (s.html_object_id = o.id OR s.screenshot_object_id = o.id)
  )
  AND NOT EXISTS (
      SELECT 1
      FROM captured_resources AS r
      WHERE r.owner_id = o.owner_id
        AND r.object_id = o.id
  )
ORDER BY o.delete_after, o.owner_id, o.id
LIMIT 500
FOR UPDATE OF o SKIP LOCKED;
```

Benchmark đặc biệt nhánh `OR` của snapshot reference. Nếu plan không dùng index
ổn định, tách thành hai `NOT EXISTS` cho HTML và screenshot thay vì thêm index
không chứng minh được lợi ích.

## 7. Bài test correctness bắt buộc

1. 300 worker claim cùng batch page: mỗi `(scan_id, page_id, generation)` có đúng
   một owner hợp lệ.
2. Worker A hết lease, worker B reclaim; completion của A trả `UPDATE 0`, B commit
   đúng một outcome.
3. Completion và cancellation chạy ở cả hai commit order; kết quả khớp policy và
   counter không double-count.
4. Hai create scan cùng website: unique active index chỉ cho một scan active.
5. Cùng idempotency key + cùng fingerprint trả cùng ID; cùng key + fingerprint
   khác trả conflict.
6. Hai URL normalized trùng được dedup; test URL dài và hash collision giả lập ở
   application comparison path.
7. Projector chạy lặp hoặc crash giữa chừng vẫn hội tụ về count từ `scan_pages`.
8. Hai active capture cùng page bị unique constraint chặn.
9. Capture worker stale không thể gắn object/snapshot hoặc complete job mới.
10. Upload thành công nhưng DB rollback tạo orphan có thể dọn; DB commit nhưng
    object mất được đánh dấu `MISSING`, không trả link giả thành công.
11. User A không thể tạo/read capture cho scan page của user B, kể cả biết UUID.
12. Purge chạy đồng thời report/capture không tạo dangling FK hoặc transaction dài.

## 8. Kịch bản tải và tiêu chí đạt

### Tải chuẩn

- 300 API RPS, 1.000 client, polling 5 giây có jitter.
- 200 page result commit/giây.
- 100–300 crawl worker và 10 browser worker.
- Capture 0,2/giây.
- Chạy ít nhất 60 phút sau warm-up để autovacuum/checkpoint xuất hiện.

### Burst và quá tải

- 1.000 API RPS trong 5 phút.
- Capture 2/giây.
- Lặp overload 2–3 lần; scan/capture mới nhận `429`/`503` có `Retry-After`, trong
  khi auth/progress/report đã có vẫn giữ SLO ưu tiên.
- Kill worker/database connection giữa claim và completion, sau đó đo recovery.

### Tiêu chí đạt

| Đường | Mục tiêu |
| --- | ---: |
| Progress | p95 < 200 ms |
| Create scan/capture | p95 < 300 ms |
| Report/page/snapshot detail | p95 < 500 ms |
| API error trong tải chuẩn | < 0,1% |
| Page commit | duy trì 200/giây, không double-count |
| Projection freshness | <= 2 giây |
| Lost worker detect/reassign | p95 <= 60 giây, max 120 giây |
| Pool wait control plane | không tăng không giới hạn; phải ghi p95/p99 |
| Correctness | 0 lost accepted job, 0 stale commit, 0 cross-owner result |

Nếu throughput không đạt, phải chỉ ra bottleneck đo được: CPU, IOPS, WAL, lock,
pool, query plan, autovacuum hoặc object store. Không kết luận “cần server mạnh
hơn” khi chưa có bằng chứng này.
