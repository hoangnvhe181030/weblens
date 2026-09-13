-- V11 guarantees that the wider replacement is valid before this short metadata
-- operation removes the legacy 100-page/one-hour/10-worker constraint.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE scans DROP CONSTRAINT ck_scans_config;
ALTER TABLE scans RENAME CONSTRAINT ck_scans_config_expanded TO ck_scans_config;
