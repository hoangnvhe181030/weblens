package com.weblens.messaging.contract;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;

public record ScanEventEnvelope(
        @NotNull UUID messageId,
        @NotBlank @Size(max = 64) String aggregateType,
        @NotNull UUID aggregateId,
        @Min(0) long aggregateVersion,
        @NotBlank @Size(max = 128) String messageType,
        @Min(1) int contractVersion,
        @NotNull UUID correlationId,
        @NotNull Instant occurredAt,
        @NotNull @Valid ScanProgressPayload payload
) {
}
