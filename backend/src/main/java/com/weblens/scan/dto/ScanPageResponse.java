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
        String description,
        String metaKeywords,
        String canonicalUrl,
        String canonicalRelation,
        String metaRobots,
        String xRobotsTag,
        String htmlLang,
        boolean indexable,
        String indexabilityReason,
        String h1,
        List<String> h1Values,
        List<String> h2,
        List<String> h3,
        List<String> h4,
        List<String> h5,
        List<String> h6,
        List<HreflangResponse> hreflang,
        OpenGraphResponse openGraph,
        StructuredDataSummaryResponse structuredData,
        long links,
        long images,
        long scripts,
        long stylesheets,
        HttpTimingResponse timing,
        List<FindingResponse> findings,
        Instant observedAt
) {
}
