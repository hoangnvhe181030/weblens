package com.weblens.scan.dto;

public record EffectiveScanConfigResponse(
        int maxPages,
        int maxDepth,
        long maxResponseBytes,
        int maxDurationSeconds,
        int maxRedirects,
        int concurrency
) {
}
