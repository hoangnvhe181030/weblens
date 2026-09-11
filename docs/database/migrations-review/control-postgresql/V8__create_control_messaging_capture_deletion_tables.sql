-- Review-only. All tables in this migration are new and must have no writers
-- until the transaction commits.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
    CONSTRAINT ck_outbox_status CHECK (
        status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')
    ),
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
    CONSTRAINT ck_inbox_outcome CHECK (
        outcome IN ('APPLIED', 'IGNORED_STALE', 'REJECTED')
    ),
    CONSTRAINT ck_inbox_timestamps CHECK (processed_at >= received_at)
);

CREATE INDEX ix_inbox_processed_purge
    ON inbox_messages (processed_at, message_id);

CREATE INDEX ix_inbox_aggregate_version
    ON inbox_messages (aggregate_type, aggregate_id, aggregate_version DESC);

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

CREATE INDEX ix_deletion_requests_owner
    ON data_deletion_requests (owner_id, id);

CREATE UNIQUE INDEX uq_deletion_active_scope
    ON data_deletion_requests (owner_id, scope_type, scope_id)
    WHERE status IN ('PENDING', 'IN_PROGRESS');

CREATE INDEX ix_deletion_targets_pending
    ON data_deletion_targets (status, updated_at, deletion_request_id)
    WHERE status IN ('PENDING', 'DISPATCHED', 'FAILED');
