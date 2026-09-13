CREATE TABLE IF NOT EXISTS capture_schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capture_jobs (
    id uuid PRIMARY KEY,
    command_message_id uuid NOT NULL UNIQUE,
    command_payload_sha256 bytea NOT NULL,
    owner_id uuid NOT NULL,
    scan_id uuid NOT NULL,
    page_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    command_version bigint NOT NULL,
    status text NOT NULL,
    target_url text NOT NULL,
    command_payload jsonb NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL,
    lease_owner uuid,
    lease_generation bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    event_version bigint NOT NULL DEFAULT 0,
    analytics_expected_count integer NOT NULL DEFAULT 0,
    analytics_published_count integer NOT NULL DEFAULT 0,
    object_count integer NOT NULL DEFAULT 0,
    total_object_bytes bigint NOT NULL DEFAULT 0,
    terminal_code text,
    terminal_message text,
    accepted_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ck_capture_jobs_status CHECK (status IN (
        'QUEUED', 'RENDERING', 'PERSISTING', 'COMPLETED', 'FAILED'
    )),
    CONSTRAINT ck_capture_jobs_hash CHECK (octet_length(command_payload_sha256) = 32),
    CONSTRAINT ck_capture_jobs_attempt CHECK (attempt_count BETWEEN 0 AND 3),
    CONSTRAINT ck_capture_jobs_version CHECK (
        command_version >= 0 AND lease_generation >= 0 AND event_version >= 0
    ),
    CONSTRAINT ck_capture_jobs_lease CHECK (
        (status = 'RENDERING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'RENDERING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX ix_capture_jobs_claim
    ON capture_jobs (available_at, accepted_at, id)
    WHERE status = 'QUEUED';

CREATE INDEX ix_capture_jobs_expired
    ON capture_jobs (lease_expires_at, id)
    WHERE status = 'RENDERING';

CREATE TABLE page_snapshots (
    id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL UNIQUE REFERENCES capture_jobs(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL,
    scan_id uuid NOT NULL,
    page_id uuid NOT NULL,
    final_url text NOT NULL,
    viewport_width integer NOT NULL,
    viewport_height integer NOT NULL,
    measurement_profile text NOT NULL,
    browser_version text NOT NULL,
    rendered_metadata jsonb NOT NULL,
    diff_summary jsonb NOT NULL,
    performance_summary jsonb NOT NULL,
    network_request_count integer NOT NULL,
    captured_resource_count integer NOT NULL,
    total_transfer_bytes bigint NOT NULL,
    storage_bucket text NOT NULL,
    html_storage_key text NOT NULL,
    html_sha256 bytea NOT NULL,
    html_bytes bigint NOT NULL,
    screenshot_storage_key text NOT NULL,
    screenshot_sha256 bytea NOT NULL,
    screenshot_bytes bigint NOT NULL,
    captured_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT ck_page_snapshot_hashes CHECK (
        octet_length(html_sha256) = 32 AND octet_length(screenshot_sha256) = 32
    ),
    CONSTRAINT ck_page_snapshot_counts CHECK (
        network_request_count BETWEEN 0 AND 500
        AND captured_resource_count BETWEEN 0 AND 100
        AND total_transfer_bytes BETWEEN 0 AND 52428800
    )
);

CREATE INDEX ix_page_snapshots_owner_capture
    ON page_snapshots (owner_id, captured_at DESC, id DESC);

CREATE INDEX ix_page_snapshots_scan_page
    ON page_snapshots (scan_id, page_id, captured_at DESC);

CREATE TABLE capture_object_references (
    id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL REFERENCES capture_jobs(id) ON DELETE RESTRICT,
    resource_id uuid NOT NULL,
    ordinal integer NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 bytea NOT NULL,
    delete_after timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT uq_capture_resource_ordinal UNIQUE (capture_job_id, ordinal),
    CONSTRAINT ck_capture_object_hash CHECK (octet_length(sha256) = 32),
    CONSTRAINT ck_capture_object_size CHECK (byte_size BETWEEN 1 AND 10485760)
);

CREATE INDEX ix_capture_object_gc
    ON capture_object_references (delete_after, id);

CREATE TABLE analytics_outbox (
    id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL UNIQUE REFERENCES capture_jobs(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL,
    result_version bigint NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    payload jsonb,
    payload_sha256 bytea NOT NULL,
    available_at timestamptz NOT NULL,
    delivery_attempts integer NOT NULL DEFAULT 0,
    lease_owner uuid,
    lease_expires_at timestamptz,
    delivered_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT ck_capture_analytics_status CHECK (status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')),
    CONSTRAINT ck_capture_analytics_hash CHECK (octet_length(payload_sha256) = 32),
    CONSTRAINT ck_capture_analytics_payload CHECK (
        (status = 'DELIVERED' AND payload IS NULL)
        OR (status <> 'DELIVERED' AND payload IS NOT NULL AND octet_length(payload::text) <= 8388608)
    )
);

CREATE INDEX ix_capture_analytics_claim
    ON analytics_outbox (available_at, created_at, id)
    WHERE status IN ('PENDING', 'CLAIMED');

CREATE TABLE event_outbox (
    message_id uuid PRIMARY KEY,
    capture_job_id uuid NOT NULL REFERENCES capture_jobs(id) ON DELETE RESTRICT,
    event_version bigint NOT NULL,
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
    CONSTRAINT uq_capture_event_version UNIQUE (capture_job_id, event_version),
    CONSTRAINT ck_capture_event_status CHECK (status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'DEAD')),
    CONSTRAINT ck_capture_event_payload CHECK (octet_length(payload::text) <= 65536)
);

CREATE INDEX ix_capture_events_claim
    ON event_outbox (available_at, created_at, message_id)
    WHERE status IN ('PENDING', 'CLAIMED');
