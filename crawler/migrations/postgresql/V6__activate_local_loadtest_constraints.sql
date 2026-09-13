-- Chỉ giữ ACCESS EXCLUSIVE trong bước đổi constraint metadata ngắn sau validation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE crawl_executions
    DROP CONSTRAINT ck_crawl_execution_policy;

ALTER TABLE crawl_executions
    RENAME CONSTRAINT ck_crawl_execution_policy_expanded
    TO ck_crawl_execution_policy;

ALTER TABLE host_leases
    DROP CONSTRAINT ck_host_leases_slot;

ALTER TABLE host_leases
    RENAME CONSTRAINT ck_host_leases_slot_expanded
    TO ck_host_leases_slot;
