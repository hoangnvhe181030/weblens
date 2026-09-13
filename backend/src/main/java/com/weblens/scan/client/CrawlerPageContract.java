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
        String description,
        String metaKeywords,
        String canonicalUrl,
        String canonicalRelation,
        String metaRobots,
        String xRobotsTag,
        String htmlLang,
        boolean indexable,
        String indexabilityReason,
        List<String> h1,
        List<String> h2,
        List<String> h3,
        List<String> h4,
        List<String> h5,
        List<String> h6,
        List<CrawlerHreflangContract> hreflang,
        String openGraphTitle,
        String openGraphDescription,
        String openGraphImageUrl,
        List<String> schemaOrgTypes,
        int schemaOrgItemCount,
        int schemaOrgValidCount,
        int schemaOrgErrorCount,
        int schemaOrgWarningCount,
        List<String> schemaOrgIssueCodes,
        long links,
        long images,
        long scripts,
        long stylesheets,
        Long dnsMillis,
        Long connectMillis,
        Long tlsMillis,
        Long ttfbMillis,
        boolean dnsObserved,
        boolean connectObserved,
        boolean tlsObserved,
        boolean ttfbObserved,
        List<CrawlerFindingContract> findings,
        Instant observedAt
) {
    public CrawlerPageContract(
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
        this(
                id, scanId, url, finalUrl, statusCode, outcome, responseTimeMs, responseBytes, title,
                null, null, null, "MISSING", null, null, null, false, "UNKNOWN",
                h1, List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
                null, null, null, List.of(), 0, 0, 0, 0, List.of(),
                links, images, 0, 0, null, null, null, null,
                false, false, false, false, findings, observedAt
        );
    }
}
