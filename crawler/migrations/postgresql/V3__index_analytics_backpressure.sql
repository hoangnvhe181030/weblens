-- Hỗ trợ kiểm tra tuổi backlog định kỳ mà không quét toàn bộ outbox đã giao.
-- Crawler database V1 chưa có production data; rollout trên database đã có dữ
-- liệu phải đo thời gian build/lock trong preflight và dùng quy trình DDL riêng.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE INDEX ix_analytics_outbox_backpressure
    ON analytics_outbox (created_at, id)
    WHERE status IN ('PENDING', 'CLAIMED', 'DEAD');
