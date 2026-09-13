CREATE DATABASE IF NOT EXISTS weblens_capture_analytics;

CREATE TABLE IF NOT EXISTS weblens_capture_analytics.rendered_page_metrics (
    owner_id UUID,
    capture_request_id UUID,
    scan_id UUID,
    page_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    final_url String CODEC(ZSTD(3)),
    document_title String CODEC(ZSTD(3)),
    meta_description String CODEC(ZSTD(3)),
    canonical_url String CODEC(ZSTD(3)),
    meta_robots String CODEC(ZSTD(3)),
    h1 Array(String) CODEC(ZSTD(3)),
    word_count UInt32,
    link_count UInt32,
    image_count UInt32,
    open_graph_title String CODEC(ZSTD(3)),
    open_graph_description String CODEC(ZSTD(3)),
    open_graph_image_url String CODEC(ZSTD(3)),
    schema_org_types Array(String) CODEC(ZSTD(3)),
    title_changed UInt8,
    description_changed UInt8,
    canonical_changed UInt8,
    h1_changed UInt8,
    content_changed UInt8,
    link_count_delta Int32,
    image_count_delta Int32,
    schema_types_changed UInt8,
    lcp_status LowCardinality(String),
    lcp_millis Float64,
    lcp_unavailable_reason LowCardinality(String),
    cls_status LowCardinality(String),
    cls_value Float64,
    cls_unavailable_reason LowCardinality(String),
    ttfb_status LowCardinality(String),
    ttfb_millis Float64,
    ttfb_unavailable_reason LowCardinality(String),
    measurement_profile LowCardinality(String),
    browser_version LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(observed_at)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, page_id)
TTL observed_at + INTERVAL 180 DAY DELETE;

CREATE TABLE IF NOT EXISTS weblens_capture_analytics.network_requests (
    owner_id UUID,
    capture_request_id UUID,
    request_id UUID,
    request_sequence UInt32,
    record_version UInt64,
    url String CODEC(ZSTD(3)),
    method LowCardinality(String),
    resource_type LowCardinality(String),
    status_code UInt16,
    mime_type LowCardinality(String),
    response_bytes UInt64,
    duration_ms UInt32,
    failure_code LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(record_version)
PARTITION BY toYYYYMM(observed_at)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, request_sequence, request_id)
TTL observed_at + INTERVAL 180 DAY DELETE;

CREATE TABLE IF NOT EXISTS weblens_capture_analytics.captured_resources (
    owner_id UUID,
    capture_request_id UUID,
    resource_id UUID,
    record_version UInt64,
    request_sequence UInt32,
    url String CODEC(ZSTD(3)),
    resource_type LowCardinality(String),
    mime_type LowCardinality(String),
    body_bytes UInt64,
    body_sha256 FixedString(32),
    was_truncated UInt8,
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(record_version)
PARTITION BY toYYYYMM(observed_at)
PRIMARY KEY (owner_id, capture_request_id)
ORDER BY (owner_id, capture_request_id, resource_id)
TTL observed_at + INTERVAL 180 DAY DELETE;

CREATE TABLE IF NOT EXISTS weblens_capture_analytics.ingestion_receipts (
    owner_id UUID,
    capture_request_id UUID,
    batch_id UUID,
    payload_sha256 FixedString(32),
    rendered_rows UInt32,
    network_rows UInt32,
    resource_rows UInt32,
    schema_version UInt16,
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (owner_id, capture_request_id, batch_id)
TTL ingested_at + INTERVAL 30 DAY DELETE;
