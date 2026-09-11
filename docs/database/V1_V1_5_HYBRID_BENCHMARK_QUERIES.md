# Benchmark schema V1/V1.5 hybrid

Trạng thái: **BỘ BENCHMARK ĐỂ REVIEW, CHƯA CHẠY TRÊN SCHEMA TRIỂN KHAI**.  
Schema đi kèm:
[V1_V1_5_HYBRID_SCHEMA_PROPOSAL.md](V1_V1_5_HYBRID_SCHEMA_PROPOSAL.md).

Mỗi kết quả phải ghi CPU/RAM/disk, PostgreSQL/ClickHouse minor version, topology,
pool size, dataset, cache state, query concurrency, p50/p95/p99, rows/bytes read,
WAL, ClickHouse parts/merges và error rate. Không dùng database rỗng hoặc một lần
chạy duy nhất để tuyên bố production-ready.

## 1. Dataset chuẩn

| Dữ liệu | Baseline |
| --- | ---: |
| User | 100.000 |
| Auth session active | 200.000–500.000 |
| Website | 300.000 giả thuyết |
| Scan summary 365 ngày | khoảng 7,3 triệu |
| Scan page workflow 180 ngày | khoảng 108 triệu |
| Page metric 180 ngày | khoảng 108 triệu logical row |
| Finding 180 ngày | khoảng 216 triệu logical row |
| Link edge | đo ở trung bình 50, p95 500, cap 2.000/page |
| Capture request 365 ngày | khoảng 6,3 triệu ở 0,2 capture/giây |
| Network fact 180 ngày | khoảng 311 triệu nếu trung bình 100/capture |
| Captured resource fact 180 ngày | khoảng 62 triệu nếu trung bình 20/capture |

Dataset phải có retry duplicate, tombstone, out-of-order version, scan sát ranh
giới tháng, owner skew 5% và noisy tenant 20%. Ít nhất 10% scan đạt 80 page; URL,
status, MIME, timing, finding severity và object size phải có phân bố lệch thực tế.

## 2. Cách đo

PostgreSQL query chạy bằng:

```sql
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, VERBOSE)
SELECT ...;
```

Theo dõi thêm `pg_stat_statements`, `pg_stat_activity`, `pg_locks`, autovacuum,
dead tuple, relation/index size, checkpoint và PgBouncer client wait.

ClickHouse query bật log và lấy từ `system.query_log`; theo dõi `read_rows`,
`read_bytes`, `query_duration_ms`, memory, exception, `system.parts`,
`system.merges`, rejected inserts và replication queue nếu production có replica.

## 3. PostgreSQL Control Plane

### P1 — Login theo normalized email

```sql
SELECT id, password_hash, status, version
FROM users
WHERE normalized_email = $1;
```

Kỳ vọng unique index hiện hữu; một row; không sequential scan ở dataset chuẩn.

### P2 — Rotate refresh token có khóa

```sql
BEGIN;

SELECT id, user_id, refresh_jti_hash, csrf_token_hash,
       expires_at, revoked_at, version
FROM auth_sessions
WHERE id = $1
FOR UPDATE;

UPDATE auth_sessions
SET refresh_jti_hash = $2,
    csrf_token_hash = $3,
    expires_at = $4,
    rotated_at = clock_timestamp(),
    version = version + 1
WHERE id = $1
  AND version = $5
  AND revoked_at IS NULL
  AND expires_at > clock_timestamp();

COMMIT;
```

Test 20 request đồng thời với cùng credential: đúng một rotate thành công; không
deadlock; các request còn lại trả failure xác định.

### P3 — Website và scan history bằng keyset

```sql
SELECT id, display_name, canonical_url, hostname, status, updated_at
FROM websites
WHERE owner_id = $1
  AND status = $2
  AND (updated_at, id) < ($3, $4)
ORDER BY updated_at DESC, id DESC
LIMIT $5;

SELECT id, website_id, status, analytics_status,
       discovered_count, processed_count, created_at
FROM scans
WHERE requested_by_user_id = $1
  AND website_id = $2
  AND (created_at, id) < ($3, $4)
ORDER BY created_at DESC, id DESC
LIMIT $5;
```

`LIMIT` mặc định 50, tối đa 100. Không benchmark `OFFSET` sâu.

### P4 — Tạo scan và outbox nguyên tử

Trong 100 request đồng thời cho cùng website, unique partial index phải cho đúng
một active scan. Retry cùng idempotency key trả aggregate cũ; key giống nhưng
fingerprint khác trả conflict.

```sql
BEGIN;

INSERT INTO scans (
    id, website_id, requested_by_user_id, status,
    max_pages, max_depth, max_response_bytes, max_duration_seconds,
    max_redirects, concurrency, collector_version,
    idempotency_key_hash, request_fingerprint_hash,
    created_at, updated_at
) VALUES (
    $1, $2, $3, 'QUEUED',
    $4, $5, $6, $7, $8, $9, $10,
    $11, $12, clock_timestamp(), clock_timestamp()
);

INSERT INTO outbox_events (...)
VALUES (...);

COMMIT;
```

Crash injection sau mỗi statement phải cho kết quả cả scan + outbox cùng có hoặc
cùng không có.

### P5 — Consume progress monotonic

```sql
BEGIN;

INSERT INTO inbox_messages (...)
VALUES (...)
ON CONFLICT (message_id) DO NOTHING
RETURNING message_id;

UPDATE scans
SET status = $2,
    discovered_count = $3,
    queued_count = $4,
    processed_count = $5,
    succeeded_count = $6,
    failed_count = $7,
    analytics_status = $8,
    analytics_expected_count = $9,
    analytics_published_count = $10,
    analytics_last_ingested_at = $11,
    remote_execution_version = $12,
    updated_at = clock_timestamp(),
    version = version + 1
WHERE id = $1
  AND remote_execution_version < $12;

COMMIT;
```

Shuffle event version 1–1.000, duplicate mỗi event ba lần: projection cuối đúng,
counter không lùi và terminal state không quay lại active.

### P6 — Claim transactional outbox

```sql
WITH next_batch AS (
    SELECT message_id
    FROM outbox_events
    WHERE status = 'PENDING'
      AND available_at <= clock_timestamp()
    ORDER BY available_at, created_at, message_id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE outbox_events o
SET status = 'CLAIMED',
    lease_owner = $2,
    lease_expires_at = clock_timestamp() + interval '30 seconds',
    delivery_attempts = delivery_attempts + 1
FROM next_batch b
WHERE o.message_id = b.message_id
RETURNING o.message_id, o.event_type, o.payload;
```

Chạy 20 dispatcher song song; không message nào được claim đồng thời bởi hai
dispatcher và lock wait p95 không vượt ngưỡng.

## 4. PostgreSQL Crawler

### P7 — Claim host slot

```sql
SELECT hostname_sha256, hostname, slot_no, lease_generation
FROM host_leases h
WHERE h.next_allowed_at <= clock_timestamp()
  AND (h.lease_owner IS NULL OR h.lease_expires_at <= clock_timestamp())
  AND EXISTS (
      SELECT 1
      FROM scan_pages p
      JOIN crawl_executions e ON e.id = p.execution_id
      WHERE p.hostname_sha256 = h.hostname_sha256
        AND p.hostname = h.hostname
        AND p.status = 'QUEUED'
        AND p.available_at <= clock_timestamp()
        AND e.status = 'RUNNING'
  )
ORDER BY h.next_allowed_at, h.hostname_sha256, h.hostname, h.slot_no
LIMIT 1
FOR UPDATE OF h SKIP LOCKED;
```

Sau khi lock slot, claim page cùng hostname trong transaction:

```sql
SELECT p.retention_month, p.id, p.execution_id, p.lease_generation
FROM scan_pages p
JOIN crawl_executions e ON e.id = p.execution_id
WHERE p.hostname_sha256 = $1
  AND p.hostname = $2
  AND p.status = 'QUEUED'
  AND p.available_at <= clock_timestamp()
  AND e.status = 'RUNNING'
ORDER BY p.priority, p.discovered_at, p.id
LIMIT 1
FOR UPDATE OF p SKIP LOCKED;
```

Test 300 worker và một hostname nhận 20% traffic: không quá hai lease active cho
hostname; trung bình không quá 2 request/giây; worker không bị convoy toàn hệ thống.

### P8 — Commit page vào analytical staging có fencing

```sql
BEGIN;

UPDATE scan_pages p
SET status = 'PERSISTING',
    pending_terminal_status = $6,
    lease_owner = NULL,
    lease_expires_at = NULL,
    fetched_at = $7,
    result_version = result_version + 1,
    updated_at = clock_timestamp()
FROM crawl_executions e
WHERE p.retention_month = $1
  AND p.id = $2
  AND p.execution_id = $3
  AND p.lease_owner = $4
  AND p.lease_generation = $5
  AND p.status = 'LEASED'
  AND e.id = p.execution_id
  AND e.status IN ('RUNNING', 'CANCEL_REQUESTED')
  AND (e.cancellation_requested_at IS NULL
       OR $7 < e.cancellation_requested_at)
RETURNING p.result_version;

INSERT INTO analytics_outbox (...)
VALUES (...);

UPDATE crawl_executions
SET leased_count = leased_count - 1,
    persisting_count = persisting_count + 1,
    analytics_expected_count = analytics_expected_count + 1,
    progress_version = progress_version + 1,
    updated_at = clock_timestamp()
WHERE id = $3;

COMMIT;
```

Test late worker, lease generation cũ, completion/cancellation cùng thời điểm và
retry transaction. Update 0 row không được insert analytical bundle hoặc tăng counter.

### P9 — Claim analytical batch

```sql
WITH next_batch AS (
    SELECT id
    FROM analytics_outbox
    WHERE status = 'PENDING'
      AND available_at <= clock_timestamp()
    ORDER BY available_at, created_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE analytics_outbox a
SET status = 'CLAIMED',
    lease_owner = $2,
    lease_expires_at = clock_timestamp() + interval '60 seconds',
    delivery_attempts = delivery_attempts + 1,
    updated_at = clock_timestamp()
FROM next_batch b
WHERE a.id = b.id
RETURNING a.id, a.execution_id, a.page_id, a.result_version,
          a.payload, a.payload_sha256;
```

Đo 200, 500 và 1.000 bundle/giây. PostgreSQL transaction p95 mục tiêu dưới 100 ms;
không để external ClickHouse call nằm trong transaction.

### P10 — Acknowledge ClickHouse đúng một lần về mặt logic

```sql
BEGIN;

WITH delivered AS (
    UPDATE analytics_outbox
    SET status = 'DELIVERED',
        payload = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        delivered_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = $1
      AND status = 'CLAIMED'
      AND lease_owner = $2
    RETURNING retention_month, execution_id, page_id,
              page_metric_count, finding_count, link_count
), completed_page AS (
    UPDATE scan_pages p
    SET status = p.pending_terminal_status,
        pending_terminal_status = NULL,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    FROM delivered d
    WHERE p.retention_month = d.retention_month
      AND p.id = d.page_id
      AND p.status = 'PERSISTING'
    RETURNING d.execution_id, p.status
)
UPDATE crawl_executions e
SET persisting_count = persisting_count - 1,
    succeeded_count = succeeded_count +
        CASE WHEN p.status = 'SUCCEEDED' THEN 1 ELSE 0 END,
    failed_count = failed_count +
        CASE WHEN p.status = 'FAILED' THEN 1 ELSE 0 END,
    skipped_count = skipped_count +
        CASE WHEN p.status = 'SKIPPED' THEN 1 ELSE 0 END,
    analytics_published_count = analytics_published_count + 1,
    analytics_last_ingested_at = clock_timestamp(),
    progress_version = progress_version + 1,
    updated_at = clock_timestamp()
FROM completed_page p
WHERE e.id = p.execution_id;

COMMIT;
```

Gửi acknowledgement cùng batch 100 lần: chỉ lần đầu thay đổi page/counter.

### P11 — Reconcile execution

```sql
SELECT
    count(*) FILTER (WHERE status = 'QUEUED') AS queued,
    count(*) FILTER (WHERE status = 'LEASED') AS leased,
    count(*) FILTER (WHERE status = 'PERSISTING') AS persisting,
    count(*) FILTER (WHERE status = 'SUCCEEDED') AS succeeded,
    count(*) FILTER (WHERE status = 'FAILED') AS failed,
    count(*) FILTER (WHERE status = 'SKIPPED') AS skipped,
    count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled
FROM scan_pages
WHERE execution_id = $1;
```

Query phải dùng execution/status index và hoàn tất dưới 200 ms ở scan tối đa 100
page. Với V2 scan lớn hơn, benchmark lại trước khi nới `max_pages`.

## 5. ClickHouse Crawl Analytics

Mọi user-facing query dùng current view. Parameter syntax dưới đây là ClickHouse
named parameter; service vẫn dùng prepared/bound parameter, không nối chuỗi SQL.

### C1 — Page explorer bằng cursor

```sql
SELECT page_id, normalized_url, final_url, fetch_outcome, status_code,
       content_type, title, discovery_depth, total_ms, observed_at
FROM weblens_crawl_analytics.page_metrics_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
  AND page_id > {after_page_id:UUID}
ORDER BY page_id
LIMIT {limit:UInt16};
```

Chạy thêm filter status code, fetch outcome, content type và depth. `limit` tối đa
100; p95 mục tiêu dưới 300 ms ở query concurrency đã ghi nhận.

### C2 — Scan summary từ page facts

```sql
SELECT
    fetch_outcome,
    status_code,
    count() AS pages,
    quantileExact(0.50)(total_ms) AS p50_ms,
    quantileExact(0.95)(total_ms) AS p95_ms,
    sum(response_bytes) AS response_bytes
FROM weblens_crawl_analytics.page_metrics_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
GROUP BY fetch_outcome, status_code
ORDER BY pages DESC;
```

### C3 — SEO filter thực tế

```sql
SELECT page_id, normalized_url, status_code, title, h1, canonical_url
FROM weblens_crawl_analytics.page_metrics_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
  AND fetch_outcome = 'SUCCESS'
  AND (empty(title) OR empty(h1) OR empty(canonical_url))
ORDER BY page_id
LIMIT {limit:UInt16};
```

### C4 — Finding distribution và detail

```sql
SELECT severity, category, rule_id, count() AS finding_count
FROM weblens_crawl_analytics.findings_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
GROUP BY severity, category, rule_id
ORDER BY finding_count DESC, severity, rule_id;

SELECT finding_id, page_id, rule_id, rule_version,
       severity, finding_code, message, evidence_json
FROM weblens_crawl_analytics.findings_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
  AND (page_id, finding_id) > ({after_page_id:UUID}, {after_finding_id:UUID})
ORDER BY page_id, finding_id
LIMIT {limit:UInt16};
```

### C5 — Link report và PageRank input

```sql
SELECT source_page_id, edge_id, target_url, target_hostname,
       anchor_text, rel_values, is_internal, is_followable
FROM weblens_crawl_analytics.page_links_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
  AND source_page_id = {source_page_id:UUID}
  AND edge_id > {after_edge_id:UUID}
ORDER BY source_page_id, edge_id
LIMIT {limit:UInt16};

SELECT source_page_id, target_url_sha256, is_followable
FROM weblens_crawl_analytics.page_links_current
WHERE owner_id = {owner_id:UUID}
  AND scan_id = {scan_id:UUID}
  AND is_internal = 1;
```

Đo full scan tối đa theo link cap và export streaming; không tải toàn graph qua
Control Plane memory.

### C6 — Receipt/watermark

```sql
SELECT batch_id, payload_sha256, page_metric_rows,
       finding_rows, link_rows, ingested_at
FROM weblens_crawl_analytics.ingestion_receipts_current
WHERE owner_id = {owner_id:UUID}
  AND aggregate_id = {scan_id:UUID}
ORDER BY batch_id;
```

Đối chiếu tổng receipt với PostgreSQL delivered metadata và logical fact count.

## 6. PostgreSQL và ClickHouse Capture

### P12 — Claim capture job

```sql
WITH next_job AS (
    SELECT id
    FROM capture_jobs
    WHERE status = 'QUEUED'
      AND available_at <= clock_timestamp()
    ORDER BY available_at, accepted_at, id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE capture_jobs j
SET status = 'LEASED',
    lease_owner = $1,
    lease_generation = lease_generation + 1,
    lease_expires_at = clock_timestamp() + interval '60 seconds',
    attempt_count = attempt_count + 1,
    started_at = coalesce(started_at, clock_timestamp()),
    updated_at = clock_timestamp()
FROM next_job n
WHERE j.id = n.id
RETURNING j.*;
```

10 worker concurrency và burst 2 capture/giây; không duplicate claim.

### P13 — Dedup object và tạo reference

```sql
BEGIN;

INSERT INTO capture_objects (
    id, owner_id, sha256, byte_size, object_kind, content_type,
    storage_bucket, storage_key, status, created_at, available_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE', $9, $9)
ON CONFLICT (owner_id, sha256, byte_size, object_kind)
DO NOTHING;

SELECT id
FROM capture_objects
WHERE owner_id = $2
  AND sha256 = $3
  AND byte_size = $4
  AND object_kind = $5
FOR UPDATE;

INSERT INTO capture_object_references (...)
VALUES (...)
ON CONFLICT (capture_job_id, reference_kind, ordinal) DO NOTHING;

COMMIT;
```

Test 20 upload đồng thời cùng hash trong một owner: một object metadata, nhiều
reference hợp lệ. Cùng hash ở owner khác không dedup chéo tenant.

### C7 — Network waterfall

```sql
SELECT request_sequence, network_request_id, method, resource_type,
       url, status_code, outcome, response_bytes,
       start_offset_ms, duration_ms, ttfb_ms, from_cache
FROM weblens_capture_analytics.network_requests_current
WHERE owner_id = {owner_id:UUID}
  AND capture_request_id = {capture_request_id:UUID}
ORDER BY request_sequence
LIMIT 500;
```

### C8 — Resource explorer

```sql
SELECT resource_id, network_request_id, url, resource_type,
       mime_type, body_bytes, object_id, object_reference_id, was_truncated
FROM weblens_capture_analytics.captured_resources_current
WHERE owner_id = {owner_id:UUID}
  AND capture_request_id = {capture_request_id:UUID}
  AND resource_id > {after_resource_id:UUID}
ORDER BY resource_id
LIMIT {limit:UInt16};
```

### P14 — Object GC không dùng refcount

```sql
SELECT o.id, o.storage_bucket, o.storage_key
FROM capture_objects o
WHERE o.status = 'DELETE_PENDING'
  AND o.delete_after <= clock_timestamp()
  AND NOT EXISTS (
      SELECT 1
      FROM capture_object_references r
      WHERE r.object_id = o.id
  )
ORDER BY o.delete_after, o.id
LIMIT $1
FOR UPDATE OF o SKIP LOCKED;
```

Xóa object bên ngoài transaction; sau storage acknowledgement mới conditional
update `DELETED`. Retry delete phải idempotent.

## 7. Correctness/failure tests bắt buộc

1. Duplicate scan/capture command và message payload hash mismatch.
2. Out-of-order progress/terminal event; terminal không quay lại active.
3. Worker cũ hoàn tất sau lease expiry/reassignment.
4. Cancellation cạnh tranh với page completion và ClickHouse acknowledgement.
5. ClickHouse insert thành công nhưng PostgreSQL ack transaction rollback.
6. ClickHouse unavailable 15 phút ở 200 result/giây; PostgreSQL giữ backlog, áp
   dụng backpressure, phục hồi và drain không mất/double count.
7. Insert cùng logical row version 1, 3, 2 và duplicate version 3; current view chỉ
   trả version 3 một lần. Insert tombstone version 4; current view không trả row.
8. Scan accepted cuối tháng và page discovered đầu tháng sau vẫn vào cùng
   retention partition/logical key.
9. Retention TTL/partition cleanup đồng thời với report.
10. Tenant A dùng ID của tenant B trên mọi report/capture/object route.
11. Poison payload vượt cap, malformed JSON/version và link/finding count overflow.
12. ClickHouse slow query/merge pressure không chiếm pool/CPU của auth endpoints.
13. Restore PostgreSQL, ClickHouse partition và S3 inventory rồi reconcile watermark.

## 8. Load profile và tiêu chí đạt

### API/Control Plane

- 300 request/giây sustained; 1.000 request/giây trong 5 phút.
- Progress/list p95 dưới 200 ms; create scan/capture p95 dưới 300 ms.
- Error rate dưới 0,1% khi healthy; load shedding trả lỗi phân loại khi vượt cap.
- PgBouncer client wait p95 dưới 50 ms; không connection storm/idle transaction.

### Crawler/PostgreSQL staging

- 200 page result/giây sustained một giờ.
- 500/giây trong 10 phút và 1.000/giây trong 5 phút để tìm headroom.
- Claim/commit/ack transaction p95 dưới 100 ms; deadlock bằng 0 ở lock order chuẩn.
- Autovacuum theo kịp; WAL/disk/bloat nằm trong hardware budget đã ghi.

### ClickHouse

- Healthy ingestion giữ freshness p95 dưới 2 giây.
- Không `too many parts`; active part count/partition và merge backlog ổn định sau burst.
- Batch trung bình ít nhất 1.000 row khi traffic đủ; `wait_for_async_insert=1` nếu
  bật server-side async insert.
- Page/capture explorer p95 dưới 300 ms; scan aggregate p95 dưới 1 giây.
- Sau outage 15 phút, drain backlog trong tối đa 15 phút trong khi traffic mới vẫn
  tiếp tục, không vượt memory/disk watermark.

### Điều kiện thất bại

Schema chưa được duyệt nếu chỉ đạt throughput bằng cách bỏ fencing, giảm
durability, dùng `wait_for_async_insert=0`, query raw table không version-safe,
tăng connection vô hạn hoặc tắt retention/security checks.

## 9. Thứ tự chạy

1. Schema syntax/smoke test trên đúng PostgreSQL và ClickHouse version đã pin.
2. Constraint/unit dataset nhỏ.
3. Concurrency/race tests.
4. Cardinality chuẩn với warm và cold cache.
5. Sustained/burst ingestion.
6. Dependency outage/backpressure/recovery.
7. Retention/deletion/restore drill.
8. Ghi kết quả, query plan và capacity envelope; chỉ sau đó mới review production.
