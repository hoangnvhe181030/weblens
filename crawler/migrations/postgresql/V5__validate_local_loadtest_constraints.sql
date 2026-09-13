-- Validate bằng khóa ShareUpdateExclusive để lượt đọc/ghi thông thường vẫn tiếp tục.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE crawl_executions
    VALIDATE CONSTRAINT ck_crawl_execution_policy_expanded;

ALTER TABLE host_leases
    VALIDATE CONSTRAINT ck_host_leases_slot_expanded;
