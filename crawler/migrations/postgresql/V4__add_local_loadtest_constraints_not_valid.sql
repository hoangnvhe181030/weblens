-- Thêm constraint mở rộng mà chưa quét bảng; constraint cũ vẫn bảo vệ mọi lượt ghi.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE crawl_executions
    ADD CONSTRAINT ck_crawl_execution_policy_expanded CHECK (
        max_pages BETWEEN 1 AND 1000000
        AND max_depth BETWEEN 0 AND 10
        AND max_response_bytes BETWEEN 1024 AND 52428800
        AND max_duration_seconds BETWEEN 1 AND 604800
        AND max_redirects BETWEEN 0 AND 10
        AND max_concurrency BETWEEN 1 AND 10000
        AND btrim(collector_version) <> ''
    ) NOT VALID;

ALTER TABLE host_leases
    ADD CONSTRAINT ck_host_leases_slot_expanded CHECK (
        slot_no BETWEEN 1 AND 10000
    ) NOT VALID;
