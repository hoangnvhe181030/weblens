package com.weblens.scan.dto;

import java.util.List;

public record StructuredDataSummaryResponse(
        List<String> types,
        int itemCount,
        int validCount,
        int errorCount,
        int warningCount,
        List<String> issueCodes
) {
}
