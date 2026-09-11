-- Review-only. Local/single-node baseline for ClickHouse 26.3.
-- Production engine/topology substitution requires the benchmark gate.
CREATE DATABASE IF NOT EXISTS weblens_crawl_analytics;

CREATE TABLE weblens_crawl_analytics.page_metrics (
    owner_id UUID,
    scan_id UUID,
    retention_month Date,
    page_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    requested_url String CODEC(ZSTD(3)),
    normalized_url String CODEC(ZSTD(3)),
    normalized_url_sha256 FixedString(32),
    final_url String CODEC(ZSTD(3)),
    hostname String,
    discovery_depth UInt16,
    fetch_outcome LowCardinality(String),
    error_code LowCardinality(String),
    error_message String CODEC(ZSTD(3)),
    status_code UInt16,
    content_type LowCardinality(String),
    content_encoding LowCardinality(String),
    redirect_count UInt8,
    redirect_urls Array(String) CODEC(ZSTD(3)),
    redirect_status_codes Array(UInt16),
    response_bytes UInt64,
    decoded_body_bytes UInt64,
    dns_ms UInt32,
    connect_ms UInt32,
    tls_ms UInt32,
    ttfb_ms UInt32,
    total_ms UInt32,
    title String CODEC(ZSTD(3)),
    title_length UInt16,
    meta_description String CODEC(ZSTD(3)),
    meta_description_length UInt16,
    canonical_url String CODEC(ZSTD(3)),
    meta_robots LowCardinality(String),
    html_lang LowCardinality(String),
    h1 Array(String) CODEC(ZSTD(3)),
    h2 Array(String) CODEC(ZSTD(3)),
    word_count UInt32,
    internal_link_count UInt32,
    external_link_count UInt32,
    image_count UInt32,
    image_missing_alt_count UInt32,
    is_indexable UInt8,
    pagerank_score Float32,
    collector_version LowCardinality(String),
    parser_version LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_page_metrics_deleted CHECK is_deleted IN (0, 1),
    CONSTRAINT ck_page_metrics_arrays CHECK
        length(redirect_urls) = length(redirect_status_codes)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, scan_id)
ORDER BY (owner_id, scan_id, page_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.page_metrics_current AS
SELECT *
FROM weblens_crawl_analytics.page_metrics FINAL
WHERE is_deleted = 0;

CREATE TABLE weblens_crawl_analytics.findings (
    owner_id UUID,
    scan_id UUID,
    retention_month Date,
    page_id UUID,
    finding_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    rule_id LowCardinality(String),
    rule_version UInt32,
    category LowCardinality(String),
    severity LowCardinality(String),
    finding_code LowCardinality(String),
    message String CODEC(ZSTD(3)),
    evidence_json String CODEC(ZSTD(3)),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_findings_deleted CHECK is_deleted IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, scan_id)
ORDER BY (owner_id, scan_id, page_id, rule_id, rule_version, finding_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.findings_current AS
SELECT *
FROM weblens_crawl_analytics.findings FINAL
WHERE is_deleted = 0;

CREATE TABLE weblens_crawl_analytics.page_links (
    owner_id UUID,
    scan_id UUID,
    retention_month Date,
    source_page_id UUID,
    edge_id UUID,
    record_version UInt64,
    is_deleted UInt8,
    schema_version UInt16,
    source_url String CODEC(ZSTD(3)),
    target_url String CODEC(ZSTD(3)),
    target_url_sha256 FixedString(32),
    target_hostname String,
    anchor_text String CODEC(ZSTD(3)),
    tag LowCardinality(String),
    rel_values Array(LowCardinality(String)),
    is_internal UInt8,
    is_followable UInt8,
    link_ordinal UInt32,
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    CONSTRAINT ck_page_links_flags CHECK
        is_deleted IN (0, 1)
        AND is_internal IN (0, 1)
        AND is_followable IN (0, 1)
)
ENGINE = ReplacingMergeTree(record_version, is_deleted)
PARTITION BY toYYYYMM(retention_month)
PRIMARY KEY (owner_id, scan_id)
ORDER BY (owner_id, scan_id, source_page_id, edge_id)
TTL observed_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.page_links_current AS
SELECT *
FROM weblens_crawl_analytics.page_links FINAL
WHERE is_deleted = 0;

CREATE TABLE weblens_crawl_analytics.ingestion_receipts (
    owner_id UUID,
    aggregate_id UUID,
    batch_id UUID,
    receipt_version UInt64,
    payload_sha256 FixedString(32),
    page_metric_rows UInt32,
    finding_rows UInt32,
    link_rows UInt32,
    schema_version UInt16,
    ingested_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(receipt_version)
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (owner_id, aggregate_id, batch_id)
TTL ingested_at + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE VIEW weblens_crawl_analytics.ingestion_receipts_current AS
SELECT *
FROM weblens_crawl_analytics.ingestion_receipts FINAL;
