-- Validation scans existing scans under SHARE UPDATE EXCLUSIVE rather than
-- combining the scan with an ACCESS EXCLUSIVE metadata change in one transaction.
-- Abort and retry outside peak traffic if latency, I/O or replication lag rises.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE scans VALIDATE CONSTRAINT ck_scans_config_expanded;
