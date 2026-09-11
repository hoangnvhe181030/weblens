-- Review-only. PostgreSQL 17 / Flyway 11.7.2.
-- Constant defaults are metadata-only on PG17, but ALTER TABLE still needs a
-- short ACCESS EXCLUSIVE lock. Flyway wraps this migration in one transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
    ) NOT VALID,
    ADD CONSTRAINT ck_scans_analytics_counts CHECK (
        analytics_expected_count >= 0
        AND analytics_published_count BETWEEN 0 AND analytics_expected_count
    ) NOT VALID,
    ADD CONSTRAINT ck_scans_cancellation_time CHECK (
        cancellation_requested_at IS NULL OR cancellation_requested_at >= created_at
    ) NOT VALID;
