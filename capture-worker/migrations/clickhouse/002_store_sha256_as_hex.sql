-- JSONEachRow vận chuyển SHA-256 dưới dạng hex 64 ký tự để tránh binary UTF-8 mơ hồ.
ALTER TABLE weblens_capture_analytics.captured_resources
    MODIFY COLUMN body_sha256 FixedString(64);

ALTER TABLE weblens_capture_analytics.ingestion_receipts
    MODIFY COLUMN payload_sha256 FixedString(64);
