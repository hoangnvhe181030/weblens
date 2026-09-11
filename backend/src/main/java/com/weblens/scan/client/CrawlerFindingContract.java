package com.weblens.scan.client;

import java.util.Map;
import java.util.UUID;

public record CrawlerFindingContract(
        UUID id,
        String severity,
        String title,
        String description,
        Map<String, Object> evidence
) {
}
