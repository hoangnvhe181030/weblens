package com.weblens.scan.model;

public record ScanProgress(
        int discovered,
        int queued,
        int processed,
        int succeeded,
        int failed,
        int limit
) {
    public ScanProgress {
        if (discovered < 0 || queued < 0 || processed < 0 || succeeded < 0 || failed < 0 || limit < 1) {
            throw new IllegalArgumentException("Scan progress values must be non-negative and limit must be positive");
        }
        if (discovered > limit || queued > limit || processed > limit) {
            throw new IllegalArgumentException("Scan progress cannot exceed the configured page limit");
        }
        if (queued > discovered || processed > discovered) {
            throw new IllegalArgumentException("Queued and processed pages cannot exceed discovered pages");
        }
        if (processed != succeeded + failed) {
            throw new IllegalArgumentException("Processed pages must equal succeeded plus failed pages");
        }
    }
}
