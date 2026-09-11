package com.weblens.scan.client;

import java.time.Instant;
import java.util.UUID;

public record CrawlerReportStateContract(
        UUID scanId,
        UUID ownerId,
        String status,
        int analyticsExpectedCount,
        int analyticsPublishedCount,
        Instant analyticsWatermark
) {
}
