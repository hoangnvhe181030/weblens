package com.weblens.capture.dto;

import java.time.Instant;
import java.util.UUID;

public record ReconstructionResponse(
        UUID id,
        String status,
        String kind,
        String engineVersion,
        int packagedCount,
        int skippedCount,
        Long archiveBytes,
        String completenessCode,
        String failureCode,
        Instant expiresAt,
        boolean downloadAvailable
) {
}
