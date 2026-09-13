package com.weblens.scan.model;

public record ScanConfiguration(
        int maxPages,
        int maxDepth,
        long maxResponseBytes,
        int maxDurationSeconds,
        int maxRedirects,
        int concurrency
) {
    public ScanConfiguration {
        if (maxPages < 1 || maxPages > 1_000_000
                || maxDepth < 0 || maxDepth > 10
                || maxResponseBytes < 1_024 || maxResponseBytes > 52_428_800
                || maxDurationSeconds < 1 || maxDurationSeconds > 604_800
                || maxRedirects < 0 || maxRedirects > 10
                || concurrency < 1 || concurrency > 10_000) {
            throw new IllegalArgumentException("Scan configuration values are outside the supported domain");
        }
    }
}
