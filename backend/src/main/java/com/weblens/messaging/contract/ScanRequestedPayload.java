package com.weblens.messaging.contract;

import java.util.UUID;

public record ScanRequestedPayload(
        UUID scanId,
        UUID ownerId,
        UUID websiteId,
        String targetUrl,
        String targetHostname,
        int maxPages,
        int maxDepth,
        long maxResponseBytes,
        int maxDurationSeconds,
        int maxRedirects,
        int maxConcurrency,
        String collectorVersion
) {
}
