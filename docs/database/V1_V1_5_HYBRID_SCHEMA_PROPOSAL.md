# Đề xuất schema V1/V1.5: PostgreSQL + ClickHouse

Trạng thái: **Schema và migration review đã được phê duyệt; chưa được phép deploy production**.  
Ngày phê duyệt schema: 2026-09-11.  
Ngày phê duyệt migration review: 2026-09-11.  
Ngày: 2026-09-11.  
Đầu vào đã duyệt: ADR-005, ADR-006, D2–D4, D6–D8, D12–D16 và H1–H10.

Tài liệu này hoàn tất bước 8–13 của cổng RED ở mức proposal. SQL dùng để review
shape, constraint, key, index và engine; chưa phải Flyway/ClickHouse migration.
Migration V1/V2 hiện hữu là bất biến và mọi thay đổi Control Plane phải là
forward migration riêng sau lần phê duyệt tiếp theo.

## 1. Kết quả thiết kế

| Datastore | Owner | Trách nhiệm |
| --- | --- | --- |
| `weblens_control` PostgreSQL | Control Plane | Identity, website, public scan/capture, authorization, projection, delivery/deletion saga |
| `weblens_crawler` PostgreSQL | Crawler | Execution, durable frontier, host slot, lease/fencing, analytical staging |
| `weblens_crawl_analytics` ClickHouse | Crawler | Page facts, findings, link edges và ingestion receipt |
| `weblens_capture` PostgreSQL | Capture | Browser job, snapshot/object lifecycle, analytical staging |
| `weblens_capture_analytics` ClickHouse | Capture | Network/resource facts và ingestion receipt |
| S3/MinIO | Capture | Rendered HTML, screenshot và resource body lớn |

Không có FK, join hoặc transaction xuyên datastore/service. UUID đi qua contract
là opaque identifier. UUID mới do application sinh theo UUIDv7; PostgreSQL 17
không cần extension. Tất cả timestamp PostgreSQL là `timestamptz`; ClickHouse dùng
`DateTime64(3, 'UTC')`.

## 2. Phương án đã xem xét

### 2.1 Ghi đồng thời PostgreSQL và ClickHouse từ worker

Bị loại vì không có distributed transaction. Crash giữa hai lần ghi tạo missing
fact hoặc page hoàn tất giả.

### 2.2 Chỉ ghi ClickHouse và dùng nó làm queue/lifecycle

Bị loại vì ClickHouse không cung cấp unique constraint, row lock và transaction
semantics phù hợp cho claim, lease, cancellation và fencing.

### 2.3 PostgreSQL staging rồi batch sink sang ClickHouse

Được chọn. Worker commit state `PERSISTING` và một payload bền vững trong local
transaction. Sink ghi batch bên ngoài transaction, sau đó acknowledgement bằng
conditional update. Retry là bình thường; ClickHouse đọc theo logical key/version.

### 2.4 Một bảng JSON/EAV cho mọi metric

Bị loại. V1 dùng wide typed page fact để giảm row count và tăng compression/query
speed. JSON chỉ dành cho evidence mở rộng có version và giới hạn byte.

## 3. Quy ước schema chung

### 3.1 PostgreSQL

- Runtime role không là owner, superuser hoặc `BYPASSRLS`; migration role riêng.
- `READ COMMITTED` là mặc định. Claim dùng `FOR UPDATE SKIP LOCKED`; completion
  dùng conditional update theo status, lease owner và generation.
- Mọi FK nội bộ có supporting index nếu không được bao phủ bởi index khác.
- Queue index là partial index trên trạng thái active; không index payload JSONB.
- Payload outbox thường tối đa 64 KiB. Analytical staging tối đa 4 MiB/page bundle
  và 8 MiB/capture bundle; giới hạn thấp hơn ở application nếu benchmark cho phép.
- Không giữ transaction khi gọi HTTP, ClickHouse, Chromium hoặc object storage.

### 3.2 ClickHouse

- `ReplacingMergeTree(record_version, is_deleted)` xử lý retry/correction theo
  logical key là toàn bộ `ORDER BY`; background merge không cung cấp correctness
  tức thời.
- Query API chỉ đọc view `*_current`, dùng `FINAL` và `is_deleted = 0`. Không query
  raw table cho user-facing report.
- Partition theo tháng của thời điểm scan/capture bắt đầu để quản lý retention,
  không partition theo tenant hoặc scan.
- Tất cả version của một logical row giữ nguyên owner, aggregate, logical identity
  và retention month. Muốn đổi key phải tombstone row cũ và insert logical row mới.
- Batch insert 1.000–10.000 row hoặc flush tối đa một giây; client đợi durable
  acknowledgement. Không dùng fire-and-forget asynchronous insert.

## 4. PostgreSQL Control Plane

### 4.1 Bảng hiện hữu được giữ nguyên

`users`, `auth_sessions`, `websites` và `scans` giữ schema trong
`V1__create_foundation_schema.sql`; `users` tiếp tục có hardening từ V2. Không tạo
lại hoặc đổi tên các bảng này.

Target forward change cho `scans`:

```sql
ALTER TABLE scans
    ADD COLUMN analytics_status text NOT NULL DEFAULT 'PENDING',
    ADD COLUMN analytics_expected_count integer NOT NULL DEFAULT 0,
    ADD COLUMN analytics_published_count integer NOT NULL DEFAULT 0,
    ADD COLUMN analytics_last_ingested_at timestamptz,
    ADD COLUMN remote_execution_version bigint NOT NULL DEFAULT 0,
    ADD COLUMN cancellation_requested_at timestamptz,
    ADD COLUMN detail_expires_at timestamptz,
    ADD CONSTRAINT ck_scans_analytics_status CHECK (
        analytics_status IN ('PENDING', 'INDEXING', 'READY', 'DEGRADED', 'EXPIRED')
    ),
    ADD CONSTRAINT ck_scans_analytics_counts CHECK (
        analytics_expected_count >= 0
        AND analytics_published_count BETWEEN 0 AND analytics_expected_count
    ),
    ADD CONSTRAINT ck_scans_cancellation_time CHECK (
        cancellation_requested_at IS NULL OR cancellation_requested_at >= created_at
    ),
    ADD CONSTRAINT uq_scans_id_requester UNIQUE (id, requested_by_user_id);

CREATE UNIQUE INDEX uq_scans_one_active_per_website
    ON scans (requested_by_user_id, website_id)
    WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED');

CREATE INDEX ix_auth_sessions_user_id
    ON auth_sessions (user_id);
```

`DEFAULT` chỉ hỗ trợ expand phase. Migration triển khai phải backfill/validate có
kiểm soát, cập nhật application rồi mới siết constraint; không chạy nguyên block
trên production mà bỏ qua lock review.

### 4.2 `capture_requests`

```sql
CREATE TABLE capture_requests (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    scan_id uuid NOT NULL,
    page_id uuid NOT NULL,
    status text NOT NULL,
    target_url text NOT NULL,
    viewport_width integer NOT NULL,
    viewport_height integer NOT NULL,
    timeout_seconds integer NOT NULL,
    max_total_bytes bigint NOT NULL,
    max_resource_bytes bigint NOT NULL,
    max_network_requests integer NOT NULL,
    max_resource_bodies integer NOT NULL,
    idempotency_key_hash text,
    request_fingerprint_hash text,
    remote_job_version bigint NOT NULL DEFAULT 0,
    analytics_status text NOT NULL DEFAULT 'PENDING',
    analytics_expected_count integer NOT NULL DEFAULT 0,
    analytics_published_count integer NOT NULL DEFAULT 0,
    object_count integer NOT NULL DEFAULT 0,
    total_object_bytes bigint NOT NULL DEFAULT 0,
    terminal_code text,
    terminal_message text,
    created_at timestamptz NOT NULL,
    cancellation_requested_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    CONSTRAINT fk_capture_requests_owner
        FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_capture_requests_owned_scan
        FOREIGN KEY (scan_id, owner_id)
        REFERENCES scans (id, requested_by_user_id) ON DELETE RESTRICT,
    CONSTRAINT ck_capture_requests_status CHECK (status IN (
        'QUEUED', 'DISPATCHED', 'RUNNING', 'CANCEL_REQUESTED', 'INDEXING',
        'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'
    )),
    CONSTRAINT ck_capture_requests_url CHECK (
        btrim(target_url) <> '' AND octet_length(target_url) <= 8192
    ),
    CONSTRAINT ck_capture_requests_policy CHECK (
        viewport_width BETWEEN 320 AND 3840
        AND viewport_height BETWEEN 240 AND 4320
        AND timeout_seconds BETWEEN 1 AND 120
        AND max_total_bytes BETWEEN 1 AND 52428800
        AND max_resource_bytes BETWEEN 1 AND 10485760
        AND max_network_requests BETWEEN 1 AND 500
        AND max_resource_bodies BETWEEN 0 AND 100
    ),
    CONSTRAINT ck_capture_requests_hash_pair CHECK (
        (idempotency_key_hash IS NULL AND request_fingerprint_hash IS NULL)
        OR (idempotency_key_hash IS NOT NULL AND request_fingerprint_hash IS NOT NULL)
    ),
    CONSTRAINT ck_capture_requests_hashes CHECK (
        (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$')
        AND (request_fingerprint_hash IS NULL OR request_fingerprint_hash ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT ck_capture_requests_analytics CHECK (
        analytics_status IN ('PENDING', 'INDEXING', 'READY', 'DEGRADED', 'EXPIRED')
        AND analytics_expected_count >= 0
        AND analytics_published_count BETWEEN 0 AND analytics_expected_count
    ),
    CONSTRAINT ck_capture_requests_counts CHECK (
        object_count BETWEEN 0 AND max_resource_bodies + 2
        AND total_object_bytes BETWEEN 0 AND max_total_bytes
    ),
    CONSTRAINT ck_capture_requests_terminal CHECK (
        (status IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
            AND finished_at IS NOT NULL)
        OR (status NOT IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
            AND finished_at IS NULL)
    ),
    CONSTRAINT ck_capture_requests_timestamps CHECK (
        updated_at >= created_at
        AND (cancellation_requested_at IS NULL OR cancellation_requested_at >= created_at)
        AND (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= created_at)
    )
);

CREATE UNIQUE INDEX uq_capture_requests_owner_idempotency
    ON capture_requests (owner_id, idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL;

CREATE UNIQUE INDEX uq_capture_requests_one_active_page
    ON capture_requests (owner_id, scan_id, page_id)
    WHERE status IN ('QUEUED', 'DISPATCHED', 'RUNNING', 'CANCEL_REQUESTED', 'INDEXING');

CREATE INDEX ix_capture_requests_owner_created
    ON capture_requests (owner_id, created_at DESC, id DESC);

CREATE INDEX ix_capture_requests_scan_page
    ON capture_requests (scan_id, page_id, created_at DESC);
```

### 4.3 `outbox_events` và `inbox_messages`

Schema này được tạo riêng trong từng PostgreSQL database; không phải bảng dùng
chung xuyên service.

```sql
CREATE TABLE outbox_events (
    message_id uuid PRIMARY KEY,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL,
    event_type text NOT NULL,
    contract_version integer NOT NULL,
    correlation_id uuid NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    available_at timestamptz NOT NULL,
    delivery_attempts integer NOT NULL DEFAULT 0,
    lease_owner uuid,
    lease_expires_at timestamptz,
    delivered_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    CONSTRAINT uq_outbox_logical_event UNIQUE (
        aggregate_type, aggregate_id, aggregate_version, event_type
    ),
    CONSTRAINT ck_outbox_names CHECK (
        btrim(aggregate_type) <> '' AND btrim(event_type) <> ''
        AND length(aggregate_type) <= 64 AND length(event_type) <= 128
    ),
    CONSTRAINT ck_outbox_version CHECK (
        aggregate_version >= 0 AND contract_version > 0
    ),
    CONSTRAINT ck_outbox_payload CHECK (octet_length(payload::text) <= 65536),
    CONSTRAINT ck_outbox_status CHECK (status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')),
    CONSTRAINT ck_outbox_attempts CHECK (delivery_attempts >= 0),
    CONSTRAINT ck_outbox_lease CHECK (
        (status = 'CLAIMED' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'CLAIMED' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_outbox_delivery CHECK (
        (status = 'DELIVERED' AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL)
    )
);

CREATE INDEX ix_outbox_claim
    ON outbox_events (available_at, created_at, message_id)
    WHERE status = 'PENDING';

CREATE INDEX ix_outbox_expired_lease
    ON outbox_events (lease_expires_at, message_id)
    WHERE status = 'CLAIMED';

CREATE INDEX ix_outbox_delivered_purge
    ON outbox_events (delivered_at, message_id)
    WHERE status = 'DELIVERED';

CREATE TABLE inbox_messages (
    message_id uuid PRIMARY KEY,
    source_service text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL,
    message_type text NOT NULL,
    contract_version integer NOT NULL,
    correlation_id uuid NOT NULL,
    payload_sha256 bytea NOT NULL,
    outcome text NOT NULL,
    received_at timestamptz NOT NULL,
    processed_at timestamptz NOT NULL,
    last_error_code text,
    CONSTRAINT ck_inbox_names CHECK (
        btrim(source_service) <> '' AND btrim(aggregate_type) <> ''
        AND btrim(message_type) <> ''
    ),
    CONSTRAINT ck_inbox_versions CHECK (
        aggregate_version >= 0 AND contract_version > 0
    ),
    CONSTRAINT ck_inbox_hash CHECK (octet_length(payload_sha256) = 32),
    CONSTRAINT ck_inbox_outcome CHECK (outcome IN ('APPLIED', 'IGNORED_STALE', 'REJECTED')),
    CONSTRAINT ck_inbox_timestamps CHECK (processed_at >= received_at)
);

CREATE INDEX ix_inbox_processed_purge
    ON inbox_messages (processed_at, message_id);

CREATE INDEX ix_inbox_aggregate_version
    ON inbox_messages (aggregate_type, aggregate_id, aggregate_version DESC);
```

### 4.4 `data_deletion_requests` và `data_deletion_targets`

Hai bảng mới được phân loại RED trong proposal vì điều phối saga và retention.
Chúng chỉ cần khi API xóa dữ liệu active được đưa vào V1/V1.5 release scope.

```sql
CREATE TABLE data_deletion_requests (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    scope_type text NOT NULL,
    scope_id uuid NOT NULL,
    status text NOT NULL,
    requested_at timestamptz NOT NULL,
    deadline_at timestamptz NOT NULL,
    completed_at timestamptz,
    failure_code text,
    version bigint NOT NULL DEFAULT 0,
    CONSTRAINT fk_deletion_owner FOREIGN KEY (owner_id)
        REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_deletion_scope CHECK (
        scope_type IN ('OWNER', 'WEBSITE', 'SCAN', 'CAPTURE')
    ),
    CONSTRAINT ck_deletion_status CHECK (
        status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')
    ),
    CONSTRAINT ck_deletion_time CHECK (
        deadline_at > requested_at
        AND (completed_at IS NULL OR completed_at >= requested_at)
    )
);

CREATE TABLE data_deletion_targets (
    deletion_request_id uuid NOT NULL,
    target_service text NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    last_message_id uuid,
    acknowledged_at timestamptz,
    last_error_code text,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (deletion_request_id, target_service),
    CONSTRAINT fk_deletion_targets_request FOREIGN KEY (deletion_request_id)
        REFERENCES data_deletion_requests (id) ON DELETE CASCADE,
    CONSTRAINT ck_deletion_target_service CHECK (
        target_service IN ('CONTROL', 'CRAWLER', 'CAPTURE', 'OBJECT_STORAGE')
    ),
    CONSTRAINT ck_deletion_target_status CHECK (
        status IN ('PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'FAILED')
    ),
    CONSTRAINT ck_deletion_target_attempt CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX uq_deletion_active_scope
    ON data_deletion_requests (owner_id, scope_type, scope_id)
    WHERE status IN ('PENDING', 'IN_PROGRESS');

CREATE INDEX ix_deletion_requests_owner
    ON data_deletion_requests (owner_id, id);

CREATE INDEX ix_deletion_targets_pending
    ON data_deletion_targets (status, updated_at, deletion_request_id)
    WHERE status IN ('PENDING', 'DISPATCHED', 'FAILED');
```

## 5. PostgreSQL Crawler

### 5.1 `crawl_executions`

```sql
CREATE TABLE crawl_executions (
    id uuid PRIMARY KEY,
    scan_id uuid NOT NULL UNIQUE,
    owner_id uuid NOT NULL,
    website_id uuid NOT NULL,
    retention_month date NOT NULL,
    status text NOT NULL,
    command_version bigint NOT NULL,
    target_url text NOT NULL,
    target_hostname text NOT NULL,
    max_pages integer NOT NULL,
    max_depth integer NOT NULL,
    max_response_bytes bigint NOT NULL,
    max_duration_seconds integer NOT NULL,
    max_redirects integer NOT NULL,
    max_concurrency integer NOT NULL,
    collector_version text NOT NULL,
    discovered_count integer NOT NULL DEFAULT 0,
    queued_count integer NOT NULL DEFAULT 0,
    leased_count integer NOT NULL DEFAULT 0,
    persisting_count integer NOT NULL DEFAULT 0,
    succeeded_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,
    skipped_count integer NOT NULL DEFAULT 0,
    cancelled_count integer NOT NULL DEFAULT 0,
    analytics_expected_count integer NOT NULL DEFAULT 0,
    analytics_published_count integer NOT NULL DEFAULT 0,
    progress_version bigint NOT NULL DEFAULT 0,
    terminal_code text,
    terminal_message text,
    accepted_at timestamptz NOT NULL,
    cancellation_requested_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    analytics_last_ingested_at timestamptz,
    updated_at timestamptz NOT NULL,
    CONSTRAINT uq_crawl_executions_scope
        UNIQUE (id, owner_id, retention_month),
    CONSTRAINT ck_crawl_execution_month CHECK (
        retention_month = date_trunc('month', accepted_at AT TIME ZONE 'UTC')::date
    ),
    CONSTRAINT ck_crawl_execution_status CHECK (status IN (
        'QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'INDEXING',
        'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'
    )),
    CONSTRAINT ck_crawl_execution_versions CHECK (
        command_version >= 0 AND progress_version >= 0
    ),
    CONSTRAINT ck_crawl_execution_target CHECK (
        btrim(target_url) <> '' AND octet_length(target_url) <= 2048
        AND btrim(target_hostname) <> '' AND length(target_hostname) <= 253
    ),
    CONSTRAINT ck_crawl_execution_policy CHECK (
        max_pages BETWEEN 1 AND 100
        AND max_depth BETWEEN 0 AND 10
        AND max_response_bytes BETWEEN 1024 AND 52428800
        AND max_duration_seconds BETWEEN 1 AND 3600
        AND max_redirects BETWEEN 0 AND 10
        AND max_concurrency BETWEEN 1 AND 10
        AND btrim(collector_version) <> ''
    ),
    CONSTRAINT ck_crawl_execution_counts CHECK (
        discovered_count BETWEEN 0 AND max_pages
        AND queued_count BETWEEN 0 AND discovered_count
        AND leased_count >= 0 AND persisting_count >= 0
        AND succeeded_count >= 0 AND failed_count >= 0
        AND skipped_count >= 0 AND cancelled_count >= 0
        AND queued_count + leased_count + persisting_count + succeeded_count
            + failed_count + skipped_count + cancelled_count = discovered_count
        AND analytics_expected_count >= 0
        AND analytics_published_count BETWEEN 0 AND analytics_expected_count
    ),
    CONSTRAINT ck_crawl_execution_terminal CHECK (
        (status IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
            AND finished_at IS NOT NULL)
        OR (status NOT IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
            AND finished_at IS NULL)
    ),
    CONSTRAINT ck_crawl_execution_timestamps CHECK (
        updated_at >= accepted_at
        AND (cancellation_requested_at IS NULL
            OR cancellation_requested_at >= accepted_at)
        AND (started_at IS NULL OR started_at >= accepted_at)
        AND (finished_at IS NULL OR finished_at >= accepted_at)
    )
);

CREATE INDEX ix_crawl_executions_owner_scan
    ON crawl_executions (owner_id, scan_id);

CREATE INDEX ix_crawl_executions_active
    ON crawl_executions (status, accepted_at, id)
    WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'INDEXING');
```

### 5.2 `scan_pages`

`scan_pages` vừa là durable frontier vừa là minimal workflow outcome. Nội dung
phân tích rộng không nằm ở đây.

```sql
CREATE TABLE scan_pages (
    retention_month date NOT NULL,
    id uuid NOT NULL,
    execution_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    normalized_url text NOT NULL,
    normalized_url_sha256 bytea NOT NULL,
    hostname text NOT NULL,
    hostname_sha256 bytea NOT NULL,
    parent_page_id uuid,
    discovery_depth integer NOT NULL,
    priority integer NOT NULL DEFAULT 100,
    status text NOT NULL,
    pending_terminal_status text,
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL,
    lease_owner uuid,
    lease_generation bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    last_error_code text,
    last_error_message text,
    result_version bigint NOT NULL DEFAULT 0,
    discovered_at timestamptz NOT NULL,
    claimed_at timestamptz,
    fetched_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (retention_month, id),
    CONSTRAINT uq_scan_pages_scope UNIQUE (
        retention_month, id, execution_id, owner_id
    ),
    CONSTRAINT fk_scan_pages_execution FOREIGN KEY (
        execution_id, owner_id, retention_month
    ) REFERENCES crawl_executions (id, owner_id, retention_month) ON DELETE RESTRICT,
    CONSTRAINT fk_scan_pages_parent FOREIGN KEY (
        retention_month, parent_page_id, execution_id, owner_id
    ) REFERENCES scan_pages (retention_month, id, execution_id, owner_id)
        ON DELETE SET NULL (parent_page_id),
    CONSTRAINT ck_scan_pages_url CHECK (
        btrim(normalized_url) <> '' AND octet_length(normalized_url) <= 8192
        AND octet_length(normalized_url_sha256) = 32
        AND btrim(hostname) <> '' AND length(hostname) <= 253
        AND octet_length(hostname_sha256) = 32
    ),
    CONSTRAINT ck_scan_pages_depth CHECK (discovery_depth BETWEEN 0 AND 10),
    CONSTRAINT ck_scan_pages_status CHECK (status IN (
        'QUEUED', 'LEASED', 'PERSISTING', 'SUCCEEDED', 'FAILED',
        'SKIPPED', 'CANCELLED'
    )),
    CONSTRAINT ck_scan_pages_pending_terminal CHECK (
        (status = 'PERSISTING' AND pending_terminal_status IN ('SUCCEEDED', 'FAILED', 'SKIPPED'))
        OR (status <> 'PERSISTING' AND pending_terminal_status IS NULL)
    ),
    CONSTRAINT ck_scan_pages_attempt CHECK (
        attempt_count BETWEEN 0 AND 3
        AND lease_generation >= 0 AND result_version >= 0
    ),
    CONSTRAINT ck_scan_pages_lease CHECK (
        (status = 'LEASED' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'LEASED' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_scan_pages_error_size CHECK (
        last_error_code IS NULL OR length(last_error_code) <= 64
    ),
    CONSTRAINT ck_scan_pages_error_message_size CHECK (
        last_error_message IS NULL OR octet_length(last_error_message) <= 1000
    ),
    CONSTRAINT ck_scan_pages_completion CHECK (
        (status IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED') AND completed_at IS NOT NULL)
        OR (status NOT IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED') AND completed_at IS NULL)
    ),
    CONSTRAINT ck_scan_pages_timestamps CHECK (
        updated_at >= discovered_at
        AND available_at >= discovered_at
        AND (claimed_at IS NULL OR claimed_at >= discovered_at)
        AND (fetched_at IS NULL OR fetched_at >= discovered_at)
        AND (completed_at IS NULL OR completed_at >= discovered_at)
    )
) PARTITION BY RANGE (retention_month);

CREATE UNIQUE INDEX uq_scan_pages_normalized_url
    ON scan_pages (
        retention_month, execution_id, normalized_url_sha256, normalized_url
    );

CREATE INDEX ix_scan_pages_claim_by_host
    ON scan_pages (
        hostname_sha256, hostname, available_at, priority, discovered_at, id
    )
    WHERE status = 'QUEUED';

CREATE INDEX ix_scan_pages_expired_lease
    ON scan_pages (lease_expires_at, id)
    WHERE status = 'LEASED';

CREATE INDEX ix_scan_pages_execution_status
    ON scan_pages (execution_id, status, id);

CREATE INDEX ix_scan_pages_parent
    ON scan_pages (retention_month, parent_page_id)
    WHERE parent_page_id IS NOT NULL;
```

Mỗi tháng phải có partition được tạo trước và một default partition chỉ dùng làm
alarm an toàn. Dữ liệu vào default partition là incident; không để nó tích tụ.
`retention_month` được copy từ execution accepted month và FK ba cột bảo đảm nó
không đổi, kể cả scan bắt đầu sát ranh giới tháng rồi phát hiện page ở tháng sau.

### 5.3 `host_leases`

Mỗi hostname có đúng hai row `slot_no` 1 và 2 để tránh một hot counter duy nhất.

```sql
CREATE TABLE host_leases (
    hostname_sha256 bytea NOT NULL,
    hostname text NOT NULL,
    slot_no smallint NOT NULL,
    lease_owner uuid,
    lease_generation bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    next_allowed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (hostname_sha256, hostname, slot_no),
    CONSTRAINT ck_host_leases_hash CHECK (octet_length(hostname_sha256) = 32),
    CONSTRAINT ck_host_leases_hostname CHECK (
        btrim(hostname) <> '' AND length(hostname) <= 253
    ),
    CONSTRAINT ck_host_leases_slot CHECK (slot_no BETWEEN 1 AND 2),
    CONSTRAINT ck_host_leases_generation CHECK (lease_generation >= 0),
    CONSTRAINT ck_host_leases_lease CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX ix_host_leases_available
    ON host_leases (next_allowed_at, lease_expires_at, hostname_sha256, hostname, slot_no);

CREATE INDEX ix_host_leases_owner
    ON host_leases (lease_owner, lease_expires_at)
    WHERE lease_owner IS NOT NULL;
```

### 5.4 `analytics_outbox`

Một row chứa bundle versioned của một page: tối đa một page metric, 50 findings
và 2.000 link edges. `links_truncated` cho biết cap đã cắt evidence.
`payload_size_bytes` là kích thước byte của payload tuần tự hóa trước khi gửi;
constraint `payload::text` là chốt chặn độc lập cho JSONB lưu trong PostgreSQL.

```sql
CREATE TABLE analytics_outbox (
    id uuid PRIMARY KEY,
    retention_month date NOT NULL,
    execution_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    page_id uuid NOT NULL,
    result_version bigint NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    payload_schema_version integer NOT NULL,
    payload jsonb,
    payload_sha256 bytea NOT NULL,
    payload_size_bytes integer NOT NULL,
    page_metric_count smallint NOT NULL,
    finding_count smallint NOT NULL,
    link_count integer NOT NULL,
    links_truncated boolean NOT NULL DEFAULT false,
    available_at timestamptz NOT NULL,
    delivery_attempts integer NOT NULL DEFAULT 0,
    lease_owner uuid,
    lease_expires_at timestamptz,
    delivered_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT uq_analytics_outbox_page_version UNIQUE (
        retention_month, page_id, result_version
    ),
    CONSTRAINT fk_analytics_outbox_execution FOREIGN KEY (
        execution_id, owner_id, retention_month
    ) REFERENCES crawl_executions (id, owner_id, retention_month) ON DELETE RESTRICT,
    CONSTRAINT fk_analytics_outbox_page FOREIGN KEY (
        retention_month, page_id, execution_id, owner_id
    ) REFERENCES scan_pages (
        retention_month, id, execution_id, owner_id
    ) ON DELETE RESTRICT,
    CONSTRAINT ck_analytics_outbox_status CHECK (
        status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')
    ),
    CONSTRAINT ck_analytics_outbox_version CHECK (
        result_version > 0 AND payload_schema_version > 0
    ),
    CONSTRAINT ck_analytics_outbox_payload CHECK (
        payload_size_bytes BETWEEN 1 AND 4194304
        AND octet_length(payload_sha256) = 32
        AND ((status = 'DELIVERED' AND payload IS NULL)
            OR (status <> 'DELIVERED' AND payload IS NOT NULL
                AND octet_length(payload::text) <= 4194304))
    ),
    CONSTRAINT ck_analytics_outbox_counts CHECK (
        page_metric_count = 1
        AND finding_count BETWEEN 0 AND 50
        AND link_count BETWEEN 0 AND 2000
    ),
    CONSTRAINT ck_analytics_outbox_attempt CHECK (delivery_attempts >= 0),
    CONSTRAINT ck_analytics_outbox_lease CHECK (
        (status = 'CLAIMED' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'CLAIMED' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_analytics_outbox_delivery CHECK (
        (status = 'DELIVERED' AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL)
    ),
    CONSTRAINT ck_analytics_outbox_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_analytics_outbox_claim
    ON analytics_outbox (available_at, created_at, id)
    WHERE status = 'PENDING';

CREATE INDEX ix_analytics_outbox_expired_lease
    ON analytics_outbox (lease_expires_at, id)
    WHERE status = 'CLAIMED';

CREATE INDEX ix_analytics_outbox_execution_pending
    ON analytics_outbox (execution_id, status, page_id);

CREATE INDEX ix_analytics_outbox_delivered_purge
    ON analytics_outbox (delivered_at, id)
    WHERE status = 'DELIVERED';
```

Crawler database cũng tạo `inbox_messages` và `outbox_events` theo mục 4.3.

## 6. ClickHouse Crawl Analytics

DDL dưới đây dùng local `ReplacingMergeTree`. Production replicated engine phải
được thay bằng macro/template migration sau khi topology được benchmark; không
đưa tên replica/shard cứng vào schema logic.

### 6.1 `page_metrics`

```sql
CREATE DATABASE IF NOT EXISTS weblens_crawl_analytics;

CREATE TABLE weblens_crawl_analytics.page_metrics (
    owner_id UUID,
    scan_id UUID,
    retention_month Date,
    page_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    requested_url String CODEC(ZSTD(3)),
    normalized_url String CODEC(ZSTD(3)),
    normalized_url_sha256 FixedString(32),
    final_url String CODEC(ZSTD(3)),
    hostname String,
    discovery_depth UInt16,
    fetch_outcome LowCardinality(String),
    error_code LowCardinality(String),
    error_message String CODEC(ZSTD(3)),
    status_code UInt16,
    content_type LowCardinality(String),
    content_encoding LowCardinality(String),
    redirect_count UInt8,
    redirect_urls Array(String) CODEC(ZSTD(3)),
    redirect_status_codes Array(UInt16),
    response_bytes UInt64,
    decoded_body_bytes UInt64,
    dns_ms UInt32,
    connect_ms UInt32,
    tls_ms UInt32,
    ttfb_ms UInt32,
    total_ms UInt32,
    title String CODEC(ZSTD(3)),
    title_length UInt16,
    meta_description String CODEC(ZSTD(3)),
    meta_description_length UInt16,
    canonical_url String CODEC(ZSTD(3)),
    meta_robots LowCardinality(String),
    html_lang LowCardinality(String),
    h1 Array(String) CODEC(ZSTD(3)),
    h2 Array(String) CODEC(ZSTD(3)),
    word_count UInt32,
    internal_link_count UInt32,
    external_link_count UInt32,
    image_count UInt32,
    image_missing_alt_count UInt32,
    is_indexable UInt8,
    pagerank_score Float32,
    collector_version LowCardinality(String),
    parser_version LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_page_metrics_deleted CHECK is_deleted IN (0, 1),
    CONSTRAINT ck_page_metrics_arrays CHECK
        length(redirect_urls) = length(redirect_status_codes)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, scan_id)
ORDER BY (owner_id, scan_id, page_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.page_metrics_current AS
SELECT *
FROM weblens_crawl_analytics.page_metrics FINAL
WHERE is_deleted = 0;
```

`page_id` là logical identity; URL hash chỉ hỗ trợ filter/đối chiếu collision-safe,
không thay UUID. Array heading và redirect đều bị giới hạn ở parser. Field CrawlObserver
khác chỉ được thêm bằng schema version + migration; không nhét toàn bộ vào Map.

### 6.2 `findings`

```sql
CREATE TABLE weblens_crawl_analytics.findings (
    owner_id UUID,
    scan_id UUID,
    retention_month Date,
    page_id UUID,
    finding_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    rule_id LowCardinality(String),
    rule_version UInt32,
    category LowCardinality(String),
    severity LowCardinality(String),
    finding_code LowCardinality(String),
    message String CODEC(ZSTD(3)),
    evidence_json String CODEC(ZSTD(3)),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_findings_deleted CHECK is_deleted IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, scan_id)
ORDER BY (owner_id, scan_id, page_id, rule_id, rule_version, finding_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.findings_current AS
SELECT *
FROM weblens_crawl_analytics.findings FINAL
WHERE is_deleted = 0;
```

`evidence_json` tối đa 16 KiB sau UTF-8 serialization và phải qua schema validation
trước staging. Finding là immutable theo rule version; correction dùng tombstone
cho `finding_id` cũ rồi insert finding mới.

### 6.3 `page_links`

```sql
CREATE TABLE weblens_crawl_analytics.page_links (
    owner_id UUID,
    scan_id UUID,
    retention_month Date,
    source_page_id UUID,
    edge_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    source_url String CODEC(ZSTD(3)),
    target_url String CODEC(ZSTD(3)),
    target_url_sha256 FixedString(32),
    target_hostname String,
    anchor_text String CODEC(ZSTD(3)),
    tag LowCardinality(String),
    rel_values Array(LowCardinality(String)),
    is_internal UInt8,
    is_followable UInt8,
    link_ordinal UInt32,
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_page_links_flags CHECK
        is_deleted IN (0, 1) AND is_internal IN (0, 1) AND is_followable IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, scan_id)
ORDER BY (owner_id, scan_id, source_page_id, edge_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.page_links_current AS
SELECT *
FROM weblens_crawl_analytics.page_links FINAL
WHERE is_deleted = 0;
```

`edge_id` được tạo deterministically trong một result bundle và giữ nguyên khi
retry. V1/V1.5 lưu tối đa 2.000 edge/page; report phải hiển thị cờ truncated từ
page fact/bundle thay vì giả vờ graph đầy đủ.

### 6.4 `ingestion_receipts`

Receipt được insert sau khi mọi fact table của batch đã acknowledgement. Vì
ClickHouse không có multi-table transaction, reconciliation vẫn kiểm tra count và
hash; receipt không tự chứng minh atomicity.

```sql
CREATE TABLE weblens_crawl_analytics.ingestion_receipts (
    owner_id UUID,
    aggregate_id UUID,
    batch_id UUID,
    receipt_version UInt64,
    payload_sha256 FixedString(32),
    page_metric_rows UInt32,
    finding_rows UInt32,
    link_rows UInt32,
    schema_version UInt16,
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(receipt_version)
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (owner_id, aggregate_id, batch_id)
TTL ingested_at + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.ingestion_receipts_current AS
SELECT *
FROM weblens_crawl_analytics.ingestion_receipts FINAL;
```

## 7. PostgreSQL Capture

Capture database tạo `inbox_messages` và `outbox_events` theo mục 4.3.

### 7.1 `capture_jobs`

```sql
CREATE TABLE capture_jobs (
    id uuid PRIMARY KEY,
    capture_request_id uuid NOT NULL UNIQUE,
    owner_id uuid NOT NULL,
    scan_id uuid NOT NULL,
    page_id uuid NOT NULL,
    command_version bigint NOT NULL,
    status text NOT NULL,
    target_url text NOT NULL,
    viewport_width integer NOT NULL,
    viewport_height integer NOT NULL,
    timeout_seconds integer NOT NULL,
    max_total_bytes bigint NOT NULL,
    max_resource_bytes bigint NOT NULL,
    max_network_requests integer NOT NULL,
    max_resource_bodies integer NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL,
    lease_owner uuid,
    lease_generation bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    analytics_expected_count integer NOT NULL DEFAULT 0,
    analytics_published_count integer NOT NULL DEFAULT 0,
    object_count integer NOT NULL DEFAULT 0,
    total_object_bytes bigint NOT NULL DEFAULT 0,
    terminal_code text,
    terminal_message text,
    accepted_at timestamptz NOT NULL,
    cancellation_requested_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    analytics_last_ingested_at timestamptz,
    updated_at timestamptz NOT NULL,
    CONSTRAINT uq_capture_jobs_scope UNIQUE (id, owner_id),
    CONSTRAINT ck_capture_jobs_status CHECK (status IN (
        'QUEUED', 'LEASED', 'RENDERING', 'PERSISTING',
        'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'
    )),
    CONSTRAINT ck_capture_jobs_versions CHECK (
        command_version >= 0 AND lease_generation >= 0
    ),
    CONSTRAINT ck_capture_jobs_target CHECK (
        btrim(target_url) <> '' AND octet_length(target_url) <= 8192
    ),
    CONSTRAINT ck_capture_jobs_policy CHECK (
        viewport_width BETWEEN 320 AND 3840
        AND viewport_height BETWEEN 240 AND 4320
        AND timeout_seconds BETWEEN 1 AND 120
        AND max_total_bytes BETWEEN 1 AND 52428800
        AND max_resource_bytes BETWEEN 1 AND 10485760
        AND max_network_requests BETWEEN 1 AND 500
        AND max_resource_bodies BETWEEN 0 AND 100
    ),
    CONSTRAINT ck_capture_jobs_attempt CHECK (attempt_count BETWEEN 0 AND 3),
    CONSTRAINT ck_capture_jobs_lease CHECK (
        (status IN ('LEASED', 'RENDERING')
            AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status NOT IN ('LEASED', 'RENDERING')
            AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_capture_jobs_counts CHECK (
        analytics_expected_count >= 0
        AND analytics_published_count BETWEEN 0 AND analytics_expected_count
        AND object_count BETWEEN 0 AND max_resource_bodies + 2
        AND total_object_bytes BETWEEN 0 AND max_total_bytes
    ),
    CONSTRAINT ck_capture_jobs_terminal CHECK (
        (status IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
            AND finished_at IS NOT NULL)
        OR (status NOT IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
            AND finished_at IS NULL)
    ),
    CONSTRAINT ck_capture_jobs_timestamps CHECK (
        updated_at >= accepted_at
        AND available_at >= accepted_at
        AND (cancellation_requested_at IS NULL
            OR cancellation_requested_at >= accepted_at)
        AND (started_at IS NULL OR started_at >= accepted_at)
        AND (finished_at IS NULL OR finished_at >= accepted_at)
    )
);

CREATE INDEX ix_capture_jobs_claim
    ON capture_jobs (available_at, accepted_at, id)
    WHERE status = 'QUEUED';

CREATE INDEX ix_capture_jobs_expired_lease
    ON capture_jobs (lease_expires_at, id)
    WHERE status IN ('LEASED', 'RENDERING');

CREATE INDEX ix_capture_jobs_owner_created
    ON capture_jobs (owner_id, accepted_at DESC, id DESC);

CREATE INDEX ix_capture_jobs_scan_page
    ON capture_jobs (scan_id, page_id, accepted_at DESC);
```

### 7.2 `capture_objects` và `capture_object_references`

Không lưu mutable refcount. Reference row là nguồn sự thật cho garbage collection.

```sql
CREATE TABLE capture_objects (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    sha256 bytea NOT NULL,
    byte_size bigint NOT NULL,
    object_kind text NOT NULL,
    content_type text NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    available_at timestamptz,
    delete_after timestamptz,
    deleted_at timestamptz,
    version bigint NOT NULL DEFAULT 0,
    CONSTRAINT uq_capture_objects_owner_hash UNIQUE (
        owner_id, sha256, byte_size, object_kind
    ),
    CONSTRAINT uq_capture_objects_scope UNIQUE (id, owner_id, object_kind),
    CONSTRAINT uq_capture_objects_storage UNIQUE (storage_bucket, storage_key),
    CONSTRAINT ck_capture_objects_hash CHECK (octet_length(sha256) = 32),
    CONSTRAINT ck_capture_objects_size CHECK (
        (object_kind = 'RESOURCE_BODY' AND byte_size BETWEEN 1 AND 10485760)
        OR (object_kind IN ('RENDERED_HTML', 'SCREENSHOT')
            AND byte_size BETWEEN 1 AND 52428800)
    ),
    CONSTRAINT ck_capture_objects_kind CHECK (
        object_kind IN ('RENDERED_HTML', 'SCREENSHOT', 'RESOURCE_BODY')
    ),
    CONSTRAINT ck_capture_objects_names CHECK (
        btrim(content_type) <> '' AND length(content_type) <= 255
        AND btrim(storage_bucket) <> '' AND length(storage_bucket) <= 255
        AND btrim(storage_key) <> '' AND octet_length(storage_key) <= 1024
    ),
    CONSTRAINT ck_capture_objects_status CHECK (
        status IN ('AVAILABLE', 'DELETE_PENDING', 'DELETED', 'FAILED')
    ),
    CONSTRAINT ck_capture_objects_lifecycle CHECK (
        (status = 'AVAILABLE' AND available_at IS NOT NULL AND deleted_at IS NULL)
        OR (status = 'DELETE_PENDING' AND available_at IS NOT NULL
            AND delete_after IS NOT NULL AND deleted_at IS NULL)
        OR (status = 'DELETED' AND deleted_at IS NOT NULL)
        OR (status = 'FAILED' AND available_at IS NULL AND deleted_at IS NULL)
    )
);

CREATE INDEX ix_capture_objects_owner_created
    ON capture_objects (owner_id, created_at DESC, id DESC);

CREATE INDEX ix_capture_objects_gc
    ON capture_objects (delete_after, id)
    WHERE status = 'DELETE_PENDING';

CREATE TABLE capture_object_references (
    id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    object_id uuid NOT NULL,
    reference_kind text NOT NULL,
    ordinal integer NOT NULL,
    analytical_resource_id uuid,
    created_at timestamptz NOT NULL,
    CONSTRAINT fk_object_references_job FOREIGN KEY (capture_job_id, owner_id)
        REFERENCES capture_jobs (id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT fk_object_references_object FOREIGN KEY (
        object_id, owner_id, reference_kind
    ) REFERENCES capture_objects (id, owner_id, object_kind) ON DELETE RESTRICT,
    CONSTRAINT uq_object_references_role UNIQUE (
        capture_job_id, reference_kind, ordinal
    ),
    CONSTRAINT ck_object_references_kind CHECK (
        reference_kind IN ('RENDERED_HTML', 'SCREENSHOT', 'RESOURCE_BODY')
    ),
    CONSTRAINT ck_object_references_ordinal CHECK (ordinal >= 0),
    CONSTRAINT ck_object_references_resource CHECK (
        (reference_kind = 'RESOURCE_BODY' AND analytical_resource_id IS NOT NULL)
        OR (reference_kind <> 'RESOURCE_BODY' AND analytical_resource_id IS NULL)
    )
);

CREATE INDEX ix_object_references_object
    ON capture_object_references (
        object_id, owner_id, reference_kind, capture_job_id
    );

CREATE INDEX ix_object_references_job
    ON capture_object_references (capture_job_id, reference_kind, ordinal);
```

Resource body giới hạn 10 MiB/object; rendered HTML/screenshot vẫn chịu tổng cap
50 MiB/capture. Tổng cap được kiểm tra trong transaction tạo references và cập
nhật `capture_jobs.total_object_bytes`.

### 7.3 `page_snapshots`

```sql
CREATE TABLE page_snapshots (
    id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    scan_id uuid NOT NULL,
    page_id uuid NOT NULL,
    final_url text NOT NULL,
    document_title text NOT NULL,
    viewport_width integer NOT NULL,
    viewport_height integer NOT NULL,
    network_request_count integer NOT NULL,
    captured_resource_count integer NOT NULL,
    total_transfer_bytes bigint NOT NULL,
    captured_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT uq_page_snapshots_job UNIQUE (capture_job_id),
    CONSTRAINT fk_page_snapshots_job FOREIGN KEY (capture_job_id, owner_id)
        REFERENCES capture_jobs (id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT ck_page_snapshots_url CHECK (
        btrim(final_url) <> '' AND octet_length(final_url) <= 8192
    ),
    CONSTRAINT ck_page_snapshots_title CHECK (octet_length(document_title) <= 4096),
    CONSTRAINT ck_page_snapshots_viewport CHECK (
        viewport_width BETWEEN 320 AND 3840 AND viewport_height BETWEEN 240 AND 4320
    ),
    CONSTRAINT ck_page_snapshots_counts CHECK (
        network_request_count BETWEEN 0 AND 500
        AND captured_resource_count BETWEEN 0 AND 100
        AND total_transfer_bytes BETWEEN 0 AND 52428800
    ),
    CONSTRAINT ck_page_snapshots_time CHECK (
        created_at >= captured_at AND expires_at > captured_at
    )
);

CREATE INDEX ix_page_snapshots_owner_captured
    ON page_snapshots (owner_id, captured_at DESC, id DESC);

CREATE INDEX ix_page_snapshots_expiry
    ON page_snapshots (expires_at, id);

CREATE INDEX ix_page_snapshots_scan_page
    ON page_snapshots (scan_id, page_id, captured_at DESC);
```

### 7.4 Capture `analytics_outbox`

```sql
CREATE TABLE analytics_outbox (
    id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    result_version bigint NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    payload_schema_version integer NOT NULL,
    payload jsonb,
    payload_sha256 bytea NOT NULL,
    payload_size_bytes integer NOT NULL,
    network_request_count integer NOT NULL,
    captured_resource_count integer NOT NULL,
    available_at timestamptz NOT NULL,
    delivery_attempts integer NOT NULL DEFAULT 0,
    lease_owner uuid,
    lease_expires_at timestamptz,
    delivered_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT uq_capture_analytics_job_version UNIQUE (capture_job_id, result_version),
    CONSTRAINT fk_capture_analytics_job FOREIGN KEY (capture_job_id, owner_id)
        REFERENCES capture_jobs (id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT ck_capture_analytics_status CHECK (
        status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')
    ),
    CONSTRAINT ck_capture_analytics_version CHECK (
        result_version > 0 AND payload_schema_version > 0
    ),
    CONSTRAINT ck_capture_analytics_payload CHECK (
        payload_size_bytes BETWEEN 1 AND 8388608
        AND octet_length(payload_sha256) = 32
        AND ((status = 'DELIVERED' AND payload IS NULL)
            OR (status <> 'DELIVERED' AND payload IS NOT NULL
                AND octet_length(payload::text) <= 8388608))
    ),
    CONSTRAINT ck_capture_analytics_counts CHECK (
        network_request_count BETWEEN 0 AND 500
        AND captured_resource_count BETWEEN 0 AND 100
    ),
    CONSTRAINT ck_capture_analytics_attempt CHECK (delivery_attempts >= 0),
    CONSTRAINT ck_capture_analytics_lease CHECK (
        (status = 'CLAIMED' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'CLAIMED' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_capture_analytics_delivery CHECK (
        (status = 'DELIVERED' AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL)
    ),
    CONSTRAINT ck_capture_analytics_timestamps CHECK (updated_at >= created_at)
);

CREATE INDEX ix_capture_analytics_claim
    ON analytics_outbox (available_at, created_at, id)
    WHERE status = 'PENDING';

CREATE INDEX ix_capture_analytics_expired_lease
    ON analytics_outbox (lease_expires_at, id)
    WHERE status = 'CLAIMED';

CREATE INDEX ix_capture_analytics_delivered_purge
    ON analytics_outbox (delivered_at, id)
    WHERE status = 'DELIVERED';
```

## 8. ClickHouse Capture Analytics

### 8.1 `network_requests`

```sql
CREATE DATABASE IF NOT EXISTS weblens_capture_analytics;

CREATE TABLE weblens_capture_analytics.network_requests (
    owner_id UUID,
    capture_request_id UUID,
    retention_month Date,
    network_request_id UUID,
    request_sequence UInt32,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    url String CODEC(ZSTD(3)),
    final_url String CODEC(ZSTD(3)),
    method LowCardinality(String),
    resource_type LowCardinality(String),
    initiator_type LowCardinality(String),
    outcome LowCardinality(String),
    failure_code LowCardinality(String),
    status_code UInt16,
    protocol LowCardinality(String),
    mime_type LowCardinality(String),
    from_cache UInt8,
    blocked_by_policy UInt8,
    redirect_count UInt8,
    request_bytes UInt64,
    response_bytes UInt64,
    start_offset_ms UInt32,
    duration_ms UInt32,
    dns_ms UInt32,
    connect_ms UInt32,
    tls_ms UInt32,
    ttfb_ms UInt32,
    cache_control String,
    content_encoding LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_network_flags CHECK
        is_deleted IN (0, 1) AND from_cache IN (0, 1) AND blocked_by_policy IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, request_sequence, network_request_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_capture_analytics.network_requests_current AS
SELECT *
FROM weblens_capture_analytics.network_requests FINAL
WHERE is_deleted = 0;
```

Không lưu raw request/response header. Chỉ field allowlist đã redaction như
`cache_control`, `content_encoding`, size và timing được phép đi vào fact.

### 8.2 `captured_resources`

```sql
CREATE TABLE weblens_capture_analytics.captured_resources (
    owner_id UUID,
    capture_request_id UUID,
    retention_month Date,
    resource_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    network_request_id UUID,
    request_sequence UInt32,
    url String CODEC(ZSTD(3)),
    resource_type LowCardinality(String),
    mime_type LowCardinality(String),
    body_bytes UInt64,
    body_sha256 FixedString(32),
    object_id UUID,
    object_reference_id UUID,
    was_truncated UInt8,
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_resource_flags CHECK
        is_deleted IN (0, 1) AND was_truncated IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, resource_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_capture_analytics.captured_resources_current AS
SELECT *
FROM weblens_capture_analytics.captured_resources FINAL
WHERE is_deleted = 0;
```

### 8.3 Capture `ingestion_receipts`

```sql
CREATE TABLE weblens_capture_analytics.ingestion_receipts (
    owner_id UUID,
    aggregate_id UUID,
    batch_id UUID,
    receipt_version UInt64,
    payload_sha256 FixedString(32),
    network_request_rows UInt32,
    captured_resource_rows UInt32,
    schema_version UInt16,
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(receipt_version)
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (owner_id, aggregate_id, batch_id)
TTL ingested_at + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_capture_analytics.ingestion_receipts_current AS
SELECT *
FROM weblens_capture_analytics.ingestion_receipts FINAL;
```

## 9. Transaction và concurrency strategy

### 9.1 Tạo scan

Control Plane dùng một `READ COMMITTED` transaction:

1. Verify website owner/status.
2. Insert `scans` và `outbox_events` cùng transaction.
3. Unique partial index chặn hai active scan cùng website; unique idempotency index
   trả lại aggregate cũ khi client retry.

Không gọi Crawler trong transaction. Dispatcher claim outbox ở transaction khác.

### 9.2 Nhận command ở Crawler

Crawler insert `inbox_messages`; insert `crawl_executions`, seed `scan_pages` và
hai `host_leases` slot/hostname trong cùng transaction. Conflict theo `message_id`
hoặc `scan_id` trở thành idempotent no-op; payload hash khác cho cùng ID là
security/data-integrity incident.

### 9.3 Claim page theo host

Scheduler khóa theo thứ tự cố định:

1. Claim một free `host_leases` row bằng `FOR UPDATE SKIP LOCKED` khi
   `next_allowed_at <= now()` và lease trống/hết hạn.
2. Claim một `scan_pages` row `QUEUED` cùng hostname, `available_at <= now()` và
   execution `RUNNING`.
3. Tăng `lease_generation`, đặt owner/expiry cho cả slot và page rồi commit.
4. Fetch ngoài transaction. Release slot bằng conditional update theo owner và
   generation; đặt `next_allowed_at` theo politeness interval.

Nếu không có page cho host, transaction không giữ slot. Mọi worker dùng cùng lock
order host → page để tránh deadlock.

### 9.4 Commit result và ClickHouse acknowledgement

Worker hoàn tất fetch bằng một transaction:

1. Conditional update page từ `LEASED` sang `PERSISTING` theo execution, page,
   owner, lease generation và scan chưa terminal.
2. Tăng `result_version`, lưu pending terminal outcome.
3. Insert đúng một analytical bundle theo unique page/version.
4. Increment execution `persisting_count`/`analytics_expected_count` atomically.

Sink claim bundle theo batch rồi commit; gọi ClickHouse ngoài transaction. Sau
acknowledgement, một transaction conditional chuyển bundle sang `DELIVERED`, xóa
payload nhưng giữ metadata bảy ngày, chuyển page sang terminal outcome và điều
chỉnh counters bằng `SET count = count + delta`. Duplicate acknowledgement update
0 row và không double count.

### 9.5 Cancellation và terminalization

Cancellation commit trước thì page completion conditional update 0 row. Page
completion commit trước được giữ và cancellation xử lý phần còn lại. Crawler chỉ
terminal khi không còn `QUEUED/LEASED/PERSISTING`, mọi analytics expected đã
published và không còn lease hợp lệ. Terminal event được ghi cùng local
transaction với execution terminal state.

### 9.6 Capture

Capture claim/fencing tương tự page. Chromium và upload S3 chạy ngoài transaction.
Sau upload, một local transaction upsert `capture_objects`, insert immutable
references/snapshot, đưa job vào `PERSISTING` và insert analytical bundle. Sink
ClickHouse acknowledgement mới terminal job và phát outbox event.

## 10. Index/ordering key gắn với query

| Query | Access path |
| --- | --- |
| Login | unique `users(normalized_email)` hiện hữu |
| Session rotate/cleanup | PK session; `ix_auth_sessions_expiry` |
| Website list | `(owner_id, status, updated_at DESC, id)` hiện hữu |
| Scan history/progress | existing owner/website/created index + scan PK |
| Capture history | `ix_capture_requests_owner_created` |
| Dispatch/event | partial outbox/inbox indexes |
| Host/page claim | `ix_host_leases_available` + `ix_scan_pages_claim_by_host` |
| Page recovery | `ix_scan_pages_expired_lease` |
| Analytical sink | partial `ix_analytics_outbox_claim` |
| Page report | ClickHouse `(owner_id, scan_id, page_id)` |
| Finding report | `(owner_id, scan_id, page_id, rule_id, ...)` |
| Link report | `(owner_id, scan_id, source_page_id, edge_id)` |
| Network waterfall | `(owner_id, capture_request_id, request_sequence, ...)` |
| Object GC | object reference index + partial `ix_capture_objects_gc` |

Không thêm GIN/trigram/bloom/data-skipping index ở baseline. Chỉ thêm sau
`EXPLAIN (ANALYZE, BUFFERS)` hoặc ClickHouse query log chứng minh sorting key chưa
đủ cho một query đã được phê duyệt.

## 11. Retention, purge và deletion

- Control `scans` và `capture_requests`: 365 ngày.
- Crawler `scan_pages` và ClickHouse crawl facts: 180 ngày.
- `page_snapshots`, ClickHouse capture facts và object/reference: 180 ngày.
- Inbox/outbox delivered: 7 ngày; poison/dead metadata: 30 ngày; unacknowledged
  outbox không purge theo tuổi.
- ClickHouse receipt: 30 ngày để reconciliation/restore drill.
- PostgreSQL purge chạy client-driven batch có commit riêng. Partitioned
  `scan_pages` detach/drop theo monthly boundary sau khi không còn FK/outbox cần giữ.
- ClickHouse TTL đảm bảo row-level 180 ngày; closed monthly partition có thể drop
  sau khi mọi row hết hạn. Không chạy table-wide `OPTIMIZE ... FINAL` định kỳ.
- Early delete tạo tombstone/mutation và acknowledgement. Control Plane chỉ hoàn
  tất saga khi Control, Crawler, Capture, ClickHouse facts và S3/MinIO đã ack.

## 12. Forward migration strategy

1. Không sửa V1/V2.
2. Tạo role/database ownership trước, revoke quyền `PUBLIC` và pin `search_path`.
3. Expand Control Plane bằng nullable/default-safe columns và bảng infrastructure;
   backfill theo batch, validate constraint rồi mới bật code đọc mới.
4. Tạo Crawler/Capture PostgreSQL schema trong database mới; chạy contract tests.
5. Tạo ClickHouse raw tables và current views; chạy duplicate/version/TTL tests.
6. Deploy sink ở shadow mode với synthetic scan; đối chiếu receipt/count/hash.
7. Bật dispatch cho tenant nội bộ, canary rồi tăng dần; có kill switch ngừng claim.
8. Chỉ contract old columns sau ít nhất một release và sau rollback window.

## 13. Những điểm cần review trước migration

Đây là các quyết định vật lý mới xuất hiện trong schema proposal:

1. Giới hạn 2.000 link/page, 50 finding/page, 4 MiB crawl bundle và 8 MiB capture bundle.
2. Page chỉ terminal sau ClickHouse acknowledgement; ClickHouse outage đưa scan
   sang `INDEXING`/degraded và tạo backpressure sau backlog 15 phút.
3. `ReplacingMergeTree` + current view `FINAL` là baseline correctness; chưa dùng
   materialized view/projection/data-skipping index.
4. ClickHouse fact TTL chính xác 180 ngày; monthly partition dùng cho lifecycle,
   không phải để tăng queryspeed .
5. `data_deletion_requests`, `data_deletion_targets` và
   `capture_object_references` là ba bảng RED bổ sung cần được chấp nhận cùng schema.
6. Production ClickHouse replication/sharding và engine macro chỉ được chốt sau
   benchmark; schema logic không phụ thuộc số shard.

Sau review migration, các invariant được harden mà không đổi business shape đã
duyệt: page parent/analytics bundle phải cùng execution + owner; object reference
phải cùng owner và đúng loại object; tổng state counters của page phải bằng số page
đã discover; object count/bytes không vượt policy snapshot. Các composite unique
key hỗ trợ FK được tính vào benchmark write amplification.

Phê duyệt tài liệu này mới cho phép tách DDL thành migration review riêng. Nó
không tự cho phép deploy production hoặc sinh JPA/Go entity.
