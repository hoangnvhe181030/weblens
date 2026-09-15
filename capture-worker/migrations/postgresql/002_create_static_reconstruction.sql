SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE reconstruction_jobs (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    capture_job_id uuid NOT NULL UNIQUE REFERENCES capture_jobs(id) ON DELETE RESTRICT,
    source_snapshot_id uuid REFERENCES page_snapshots(id) ON DELETE RESTRICT,
    kind text NOT NULL DEFAULT 'STATIC_PAGE_ARCHIVE',
    engine_name text NOT NULL DEFAULT 'pagesource-adapter',
    engine_version text NOT NULL,
    status text NOT NULL DEFAULT 'QUEUED',
    include_external boolean NOT NULL DEFAULT false,
    max_files integer NOT NULL DEFAULT 100,
    max_input_bytes bigint NOT NULL DEFAULT 52428800,
    max_archive_bytes bigint NOT NULL DEFAULT 67108864,
    discovered_count integer NOT NULL DEFAULT 0,
    packaged_count integer NOT NULL DEFAULT 0,
    skipped_count integer NOT NULL DEFAULT 0,
    input_bytes bigint NOT NULL DEFAULT 0,
    archive_bytes bigint,
    completeness_code text,
    failure_code text,
    source_lease_generation bigint,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    CONSTRAINT uq_reconstruction_jobs_owner UNIQUE (id, owner_id),
    CONSTRAINT ck_reconstruction_kind CHECK (kind = 'STATIC_PAGE_ARCHIVE'),
    CONSTRAINT ck_reconstruction_engine CHECK (engine_name = 'pagesource-adapter'),
    CONSTRAINT ck_reconstruction_status CHECK (status IN (
        'QUEUED', 'RUNNING', 'PUBLISHED', 'PARTIAL', 'FAILED', 'EXPIRED'
    )),
    CONSTRAINT ck_reconstruction_policy CHECK (
        include_external = false
        AND max_files BETWEEN 1 AND 100
        AND max_input_bytes BETWEEN 1 AND 52428800
        AND max_archive_bytes BETWEEN 1 AND 67108864
    ),
    CONSTRAINT ck_reconstruction_counts CHECK (
        discovered_count >= 0
        AND packaged_count BETWEEN 0 AND max_files
        AND skipped_count >= 0
        AND packaged_count + skipped_count <= discovered_count
        AND input_bytes BETWEEN 0 AND max_input_bytes
        AND (archive_bytes IS NULL OR archive_bytes BETWEEN 1 AND max_archive_bytes)
    ),
    CONSTRAINT ck_reconstruction_codes CHECK (
        (completeness_code IS NULL OR octet_length(completeness_code) BETWEEN 1 AND 64)
        AND (failure_code IS NULL OR octet_length(failure_code) BETWEEN 1 AND 64)
    ),
    CONSTRAINT ck_reconstruction_generation CHECK (
        (source_lease_generation IS NULL OR source_lease_generation >= 0)
        AND version >= 0
    ),
    CONSTRAINT ck_reconstruction_lifecycle CHECK (
        (status = 'QUEUED' AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL
            AND source_lease_generation IS NOT NULL)
        OR (status IN ('PUBLISHED', 'PARTIAL') AND source_snapshot_id IS NOT NULL
            AND archive_bytes IS NOT NULL AND finished_at IS NOT NULL
            AND completeness_code IS NOT NULL AND failure_code IS NULL)
        OR (status = 'FAILED' AND finished_at IS NOT NULL AND failure_code IS NOT NULL)
        OR (status = 'EXPIRED' AND finished_at IS NOT NULL)
    ),
    CONSTRAINT ck_reconstruction_timestamps CHECK (
        (started_at IS NULL OR started_at >= created_at)
        AND (finished_at IS NULL OR finished_at >= COALESCE(started_at, created_at))
        AND updated_at >= created_at
    )
);

CREATE INDEX ix_reconstruction_jobs_owner_created
    ON reconstruction_jobs (owner_id, created_at DESC, id DESC);

CREATE INDEX ix_reconstruction_jobs_active
    ON reconstruction_jobs (status, updated_at, id)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE reconstruction_artifacts (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    reconstruction_job_id uuid NOT NULL,
    kind text NOT NULL,
    generation bigint NOT NULL,
    logical_filename text NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 bytea NOT NULL,
    state text NOT NULL,
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    delete_after timestamptz NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT fk_reconstruction_artifact_owner
        FOREIGN KEY (reconstruction_job_id, owner_id)
        REFERENCES reconstruction_jobs(id, owner_id) ON DELETE RESTRICT,
    CONSTRAINT uq_reconstruction_artifact_generation
        UNIQUE (reconstruction_job_id, kind, generation),
    CONSTRAINT ck_reconstruction_artifact_kind CHECK (kind IN ('STATIC_ARCHIVE', 'MANIFEST')),
    CONSTRAINT ck_reconstruction_artifact_content_type CHECK (
        (kind = 'STATIC_ARCHIVE' AND content_type = 'application/zip')
        OR (kind = 'MANIFEST' AND content_type = 'application/json')
    ),
    CONSTRAINT ck_reconstruction_artifact_state CHECK (
        state IN ('STAGED', 'PUBLISHED', 'DELETE_PENDING', 'DELETED')
    ),
    CONSTRAINT ck_reconstruction_artifact_integrity CHECK (
        generation >= 1
        AND octet_length(logical_filename) BETWEEN 1 AND 128
        AND byte_size BETWEEN 1 AND 67108864
        AND octet_length(sha256) = 32
    ),
    CONSTRAINT ck_reconstruction_artifact_lifecycle CHECK (
        (state = 'STAGED' AND published_at IS NULL AND deleted_at IS NULL)
        OR (state IN ('PUBLISHED', 'DELETE_PENDING') AND published_at IS NOT NULL AND deleted_at IS NULL)
        OR (state = 'DELETED' AND deleted_at IS NOT NULL)
    ),
    CONSTRAINT ck_reconstruction_artifact_retention CHECK (
        delete_after > created_at
        AND (published_at IS NULL OR published_at >= created_at)
        AND (deleted_at IS NULL OR deleted_at >= created_at)
    )
);

CREATE INDEX ix_reconstruction_artifacts_owner_download
    ON reconstruction_artifacts (owner_id, reconstruction_job_id, kind)
    WHERE state = 'PUBLISHED';

CREATE INDEX ix_reconstruction_artifacts_gc
    ON reconstruction_artifacts (delete_after, id)
    WHERE state IN ('PUBLISHED', 'DELETE_PENDING');
