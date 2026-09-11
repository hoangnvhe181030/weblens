package com.weblens.scan.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record ScanPageResponse(
        UUID id,
        UUID scanId,
        String path,
        String url,
        Integer statusCode,
        String outcome,
        Long responseTimeMs,
        Long responseBytes,
        String title,
        String h1,
        long links,
        long images,
        long scripts,
        long stylesheets,
        List<FindingResponse> findings,
        Instant observedAt
) {
}
