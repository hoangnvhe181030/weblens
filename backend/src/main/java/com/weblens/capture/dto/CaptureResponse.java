package com.weblens.capture.dto;

import com.weblens.capture.model.CaptureStatus;
import java.time.Instant;
import java.util.UUID;

public record CaptureResponse(
        UUID id,
        UUID scanId,
        UUID pageId,
        CaptureStatus status,
        String targetUrl,
        String measurementProfile,
        int analyticsExpectedCount,
        int analyticsPublishedCount,
        int objectCount,
        long totalObjectBytes,
        String terminalCode,
        String terminalMessage,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt
) {
}
