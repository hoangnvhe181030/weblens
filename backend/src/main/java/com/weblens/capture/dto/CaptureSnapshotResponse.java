package com.weblens.capture.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record CaptureSnapshotResponse(
        UUID id,
        UUID captureRequestId,
        UUID scanId,
        UUID scanPageId,
        String status,
        Instant createdAt,
        String finalUrl,
        String viewport,
        int viewportWidth,
        int viewportHeight,
        String measurementProfile,
        String browserVersion,
        int resourceCount,
        int capturedResourceCount,
        long totalBytes,
        Map<String, Object> rendered,
        Map<String, Object> diff,
        Map<String, Object> performance,
        CaptureArtifactsResponse artifacts,
        ReconstructionResponse reconstruction,
        List<CapturedResourceResponse> resources
) {
}
