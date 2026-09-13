package com.weblens.capture.dto;

import java.util.UUID;

public record CapturedResourceResponse(
        UUID id,
        String url,
        String method,
        int status,
        String type,
        String contentType,
        long sizeBytes,
        long durationMs,
        boolean bodyCaptured,
        UUID capturedBodyId,
        long capturedBodyBytes,
        String bodySha256,
        boolean bodyTruncated
) {
}
