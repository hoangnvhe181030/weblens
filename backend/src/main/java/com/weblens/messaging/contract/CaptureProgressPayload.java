package com.weblens.messaging.contract;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public record CaptureProgressPayload(
        @NotNull UUID captureRequestId,
        @NotNull UUID ownerId,
        @NotBlank @Size(max = 32) String status,
        @Min(0) int analyticsExpectedCount,
        @Min(0) int analyticsPublishedCount,
        @Min(0) @Max(102) int objectCount,
        @Min(0) @Max(52_428_800) long totalObjectBytes,
        @Size(max = 64) String terminalCode,
        @Size(max = 500) String terminalMessage
) {
}
