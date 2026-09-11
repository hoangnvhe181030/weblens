package com.weblens.scan.client;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record CrawlerPageContract(
        UUID id,
        UUID scanId,
        String url,
        String finalUrl,
        Integer statusCode,
        String outcome,
        Long responseTimeMs,
        Long responseBytes,
        String title,
        List<String> h1,
        long links,
        long images,
        List<CrawlerFindingContract> findings,
        Instant observedAt
) {
}
