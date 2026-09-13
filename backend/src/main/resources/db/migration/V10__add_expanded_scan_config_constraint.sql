-- PostgreSQL 17 / Flyway 11.7.2.
-- The new wider constraint is added without scanning existing rows. The old,
-- narrower constraint remains validated and enforced until V12 completes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE scans
    ADD CONSTRAINT ck_scans_config_expanded CHECK (
        max_pages BETWEEN 1 AND 1000000
        AND max_depth BETWEEN 0 AND 10
        AND max_response_bytes BETWEEN 1024 AND 52428800
        AND max_duration_seconds BETWEEN 1 AND 604800
        AND max_redirects BETWEEN 0 AND 10
        AND concurrency BETWEEN 1 AND 10000
    ) NOT VALID;
