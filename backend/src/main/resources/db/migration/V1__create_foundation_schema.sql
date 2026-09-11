CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    normalized_email VARCHAR(254) NOT NULL,
    display_name VARCHAR(80) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'DISABLED')),
    CONSTRAINT ck_users_email_not_blank CHECK (btrim(email) <> ''),
    CONSTRAINT ck_users_normalized_email CHECK (normalized_email = lower(btrim(normalized_email))),
    CONSTRAINT ck_users_display_name_not_blank CHECK (btrim(display_name) <> ''),
    CONSTRAINT ck_users_timestamps CHECK (updated_at >= created_at),
    CONSTRAINT uq_users_normalized_email UNIQUE (normalized_email)
);

CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    refresh_jti_hash VARCHAR(64) NOT NULL,
    csrf_token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    rotated_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT uq_auth_sessions_refresh_jti_hash UNIQUE (refresh_jti_hash),
    CONSTRAINT ck_auth_sessions_refresh_hash CHECK (refresh_jti_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_auth_sessions_csrf_hash CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_auth_sessions_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_auth_sessions_revoked_at CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CONSTRAINT ck_auth_sessions_rotated_at CHECK (rotated_at IS NULL OR rotated_at >= created_at)
);

CREATE INDEX ix_auth_sessions_user_active
    ON auth_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX ix_auth_sessions_expiry ON auth_sessions (expires_at);

CREATE TABLE websites (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    canonical_url VARCHAR(2048) NOT NULL,
    hostname VARCHAR(253) NOT NULL,
    status VARCHAR(16) NOT NULL,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_websites_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT uq_websites_id_owner UNIQUE (id, owner_id),
    CONSTRAINT ck_websites_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    CONSTRAINT ck_websites_display_name_not_blank CHECK (btrim(display_name) <> ''),
    CONSTRAINT ck_websites_canonical_url_not_blank CHECK (btrim(canonical_url) <> ''),
    CONSTRAINT ck_websites_hostname_not_blank CHECK (btrim(hostname) <> ''),
    CONSTRAINT ck_websites_archive_state CHECK (
        (status = 'ACTIVE' AND archived_at IS NULL)
        OR (status = 'ARCHIVED' AND archived_at IS NOT NULL)
    ),
    CONSTRAINT ck_websites_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_websites_owner_active_url
    ON websites (owner_id, canonical_url)
    WHERE status = 'ACTIVE';

CREATE INDEX ix_websites_owner_status_updated
    ON websites (owner_id, status, updated_at DESC, id ASC);

CREATE TABLE scans (
    id UUID PRIMARY KEY,
    website_id UUID NOT NULL,
    requested_by_user_id UUID NOT NULL,
    status VARCHAR(24) NOT NULL,
    discovered_count INTEGER NOT NULL DEFAULT 0,
    queued_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    succeeded_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    max_pages INTEGER NOT NULL,
    max_depth INTEGER NOT NULL,
    max_response_bytes BIGINT NOT NULL,
    max_duration_seconds INTEGER NOT NULL,
    max_redirects INTEGER NOT NULL,
    concurrency INTEGER NOT NULL,
    collector_version VARCHAR(64) NOT NULL,
    terminal_code VARCHAR(64),
    terminal_message VARCHAR(500),
    idempotency_key_hash VARCHAR(64),
    request_fingerprint_hash VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_scans_owned_website FOREIGN KEY (website_id, requested_by_user_id)
        REFERENCES websites (id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT fk_scans_requesting_user FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_scans_status CHECK (status IN (
        'QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'
    )),
    CONSTRAINT ck_scans_progress_non_negative CHECK (
        discovered_count >= 0 AND queued_count >= 0 AND processed_count >= 0
        AND succeeded_count >= 0 AND failed_count >= 0
    ),
    CONSTRAINT ck_scans_progress_limit CHECK (
        discovered_count <= max_pages AND queued_count <= max_pages AND processed_count <= max_pages
    ),
    CONSTRAINT ck_scans_progress_discovered CHECK (
        queued_count <= discovered_count AND processed_count <= discovered_count
    ),
    CONSTRAINT ck_scans_processed_total CHECK (processed_count = succeeded_count + failed_count),
    CONSTRAINT ck_scans_config CHECK (
        max_pages BETWEEN 1 AND 100
        AND max_depth BETWEEN 0 AND 10
        AND max_response_bytes BETWEEN 1024 AND 52428800
        AND max_duration_seconds BETWEEN 1 AND 3600
        AND max_redirects BETWEEN 0 AND 10
        AND concurrency BETWEEN 1 AND 10
    ),
    CONSTRAINT ck_scans_collector_version_not_blank CHECK (btrim(collector_version) <> ''),
    CONSTRAINT ck_scans_idempotency_pair CHECK (
        (idempotency_key_hash IS NULL AND request_fingerprint_hash IS NULL)
        OR (idempotency_key_hash IS NOT NULL AND request_fingerprint_hash IS NOT NULL)
    ),
    CONSTRAINT ck_scans_idempotency_hash CHECK (
        idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT ck_scans_fingerprint_hash CHECK (
        request_fingerprint_hash IS NULL OR request_fingerprint_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT ck_scans_terminal_time CHECK (
        (status IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL)
        OR (status NOT IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED') AND finished_at IS NULL)
    ),
    CONSTRAINT ck_scans_started_at CHECK (started_at IS NULL OR started_at >= created_at),
    CONSTRAINT ck_scans_finished_at CHECK (finished_at IS NULL OR finished_at >= created_at),
    CONSTRAINT ck_scans_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_scans_user_idempotency_key
    ON scans (requested_by_user_id, idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL;

CREATE INDEX ix_scans_user_website_created
    ON scans (requested_by_user_id, website_id, created_at DESC, id DESC);

CREATE INDEX ix_scans_website_status
    ON scans (website_id, status);
