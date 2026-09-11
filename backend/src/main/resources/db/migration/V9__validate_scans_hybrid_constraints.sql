-- Each VALIDATE scans existing rows. Run outside peak traffic and abort when
-- I/O, latency or replication lag exceeds the documented budget.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE scans VALIDATE CONSTRAINT ck_scans_analytics_status;
ALTER TABLE scans VALIDATE CONSTRAINT ck_scans_analytics_counts;
ALTER TABLE scans VALIDATE CONSTRAINT ck_scans_cancellation_time;
