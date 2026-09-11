-- Review-only. Fresh capture-worker-owned PostgreSQL database.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
    CONSTRAINT ck_page_snapshots_title CHECK (
        octet_length(document_title) <= 4096
    ),
    CONSTRAINT ck_page_snapshots_viewport CHECK (
        viewport_width BETWEEN 320 AND 3840
        AND viewport_height BETWEEN 240 AND 4320
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
    CONSTRAINT uq_capture_analytics_job_version UNIQUE (
        capture_job_id, result_version
    ),
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
