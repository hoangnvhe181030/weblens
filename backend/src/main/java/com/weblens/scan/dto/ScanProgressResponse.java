package com.weblens.scan.dto;

public record ScanProgressResponse(
        int discovered,
        int queued,
        int processed,
        int succeeded,
        int failed,
        int limit
) {
}
