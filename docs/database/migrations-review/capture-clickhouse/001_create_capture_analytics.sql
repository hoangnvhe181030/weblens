-- Review-only. Local/single-node baseline for ClickHouse 26.3.
-- Raw request/response headers and bodies are intentionally excluded.
CREATE DATABASE IF NOT EXISTS weblens_capture_analytics;

CREATE TABLE weblens_capture_analytics.network_requests (
    owner_id UUID,
    capture_request_id UUID,
    retention_month Date,
    network_request_id UUID,
    request_sequence UInt32,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    url String CODEC(ZSTD(3)),
    final_url String CODEC(ZSTD(3)),
    method LowCardinality(String),
    resource_type LowCardinality(String),
    initiator_type LowCardinality(String),
    outcome LowCardinality(String),
    failure_code LowCardinality(String),
    status_code UInt16,
    protocol LowCardinality(String),
    mime_type LowCardinality(String),
    from_cache UInt8,
    blocked_by_policy UInt8,
    redirect_count UInt8,
    request_bytes UInt64,
    response_bytes UInt64,
    start_offset_ms UInt32,
    duration_ms UInt32,
    dns_ms UInt32,
    connect_ms UInt32,
    tls_ms UInt32,
    ttfb_ms UInt32,
    cache_control String,
    content_encoding LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_network_flags CHECK
        is_deleted IN (0, 1)
        AND from_cache IN (0, 1)
        AND blocked_by_policy IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, request_sequence, network_request_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_capture_analytics.network_requests_current AS
SELECT *
FROM weblens_capture_analytics.network_requests FINAL
WHERE is_deleted = 0;

CREATE TABLE weblens_capture_analytics.captured_resources (
    owner_id UUID,
    capture_request_id UUID,
    retention_month Date,
    resource_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    network_request_id UUID,
    request_sequence UInt32,
    url String CODEC(ZSTD(3)),
    resource_type LowCardinality(String),
    mime_type LowCardinality(String),
    body_bytes UInt64,
    body_sha256 FixedString(32),
    object_id UUID,
    object_reference_id UUID,
    was_truncated UInt8,
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_resource_flags CHECK
        is_deleted IN (0, 1) AND was_truncated IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, resource_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_capture_analytics.captured_resources_current AS
SELECT *
FROM weblens_capture_analytics.captured_resources FINAL
WHERE is_deleted = 0;

CREATE TABLE weblens_capture_analytics.ingestion_receipts (
    owner_id UUID,
    aggregate_id UUID,
    batch_id UUID,
    receipt_version UInt64,
    payload_sha256 FixedString(32),
    network_request_rows UInt32,
    captured_resource_rows UInt32,
    schema_version UInt16,
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(receipt_version)
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (owner_id, aggregate_id, batch_id)
TTL ingested_at + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_capture_analytics.ingestion_receipts_current AS
SELECT *
FROM weblens_capture_analytics.ingestion_receipts FINAL;
