-- Runtime migration. Fresh crawler-owned PostgreSQL database.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
        (status = 'PERSISTING'
            AND pending_terminal_status IN ('SUCCEEDED', 'FAILED', 'SKIPPED'))
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
        (status IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')
            AND completed_at IS NOT NULL)
        OR (status NOT IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')
            AND completed_at IS NULL)
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
    ON host_leases (
        next_allowed_at, lease_expires_at, hostname_sha256, hostname, slot_no
    );

CREATE INDEX ix_host_leases_owner
    ON host_leases (lease_owner, lease_expires_at)
    WHERE lease_owner IS NOT NULL;

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
