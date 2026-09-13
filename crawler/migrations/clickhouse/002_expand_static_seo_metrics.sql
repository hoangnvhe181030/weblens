-- Forward migration cho SEO metadata tĩnh và trạng thái timing của TASK-011.
ALTER TABLE weblens_crawl_analytics.page_metrics
    ADD COLUMN IF NOT EXISTS dns_observed UInt8 AFTER dns_ms,
    ADD COLUMN IF NOT EXISTS connect_observed UInt8 AFTER connect_ms,
    ADD COLUMN IF NOT EXISTS tls_observed UInt8 AFTER tls_ms,
    ADD COLUMN IF NOT EXISTS ttfb_observed UInt8 AFTER ttfb_ms,
    ADD COLUMN IF NOT EXISTS meta_keywords String CODEC(ZSTD(3)) AFTER meta_description_length,
    ADD COLUMN IF NOT EXISTS canonical_relation LowCardinality(String) AFTER canonical_url,
    ADD COLUMN IF NOT EXISTS x_robots_tag String CODEC(ZSTD(3)) AFTER meta_robots,
    ADD COLUMN IF NOT EXISTS h3 Array(String) CODEC(ZSTD(3)) AFTER h2,
    ADD COLUMN IF NOT EXISTS h4 Array(String) CODEC(ZSTD(3)) AFTER h3,
    ADD COLUMN IF NOT EXISTS h5 Array(String) CODEC(ZSTD(3)) AFTER h4,
    ADD COLUMN IF NOT EXISTS h6 Array(String) CODEC(ZSTD(3)) AFTER h5,
    ADD COLUMN IF NOT EXISTS hreflang_languages Array(String) CODEC(ZSTD(3)) AFTER h6,
    ADD COLUMN IF NOT EXISTS hreflang_urls Array(String) CODEC(ZSTD(3)) AFTER hreflang_languages,
    ADD COLUMN IF NOT EXISTS open_graph_title String CODEC(ZSTD(3)) AFTER hreflang_urls,
    ADD COLUMN IF NOT EXISTS open_graph_description String CODEC(ZSTD(3)) AFTER open_graph_title,
    ADD COLUMN IF NOT EXISTS open_graph_image_url String CODEC(ZSTD(3)) AFTER open_graph_description,
    ADD COLUMN IF NOT EXISTS schema_org_types Array(String) CODEC(ZSTD(3)) AFTER open_graph_image_url,
    ADD COLUMN IF NOT EXISTS schema_org_item_count UInt16 AFTER schema_org_types,
    ADD COLUMN IF NOT EXISTS schema_org_valid_count UInt16 AFTER schema_org_item_count,
    ADD COLUMN IF NOT EXISTS schema_org_error_count UInt16 AFTER schema_org_valid_count,
    ADD COLUMN IF NOT EXISTS schema_org_warning_count UInt16 AFTER schema_org_error_count,
    ADD COLUMN IF NOT EXISTS schema_org_issue_codes Array(LowCardinality(String)) AFTER schema_org_warning_count,
    ADD COLUMN IF NOT EXISTS script_count UInt32 AFTER image_missing_alt_count,
    ADD COLUMN IF NOT EXISTS stylesheet_count UInt32 AFTER script_count,
    ADD COLUMN IF NOT EXISTS indexability_reason LowCardinality(String) AFTER is_indexable,
    ADD INDEX IF NOT EXISTS idx_indexability_reason indexability_reason TYPE set(64) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_canonical_relation canonical_relation TYPE set(16) GRANULARITY 4;

CREATE OR REPLACE VIEW weblens_crawl_analytics.page_metrics_current AS
SELECT *
FROM weblens_crawl_analytics.page_metrics FINAL
WHERE is_deleted = 0;
