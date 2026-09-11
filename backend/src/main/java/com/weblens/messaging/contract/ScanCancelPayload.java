package com.weblens.messaging.contract;

import java.time.Instant;
import java.util.UUID;

public record ScanCancelPayload(
        UUID scanId,
        UUID ownerId,
        Instant requestedAt
) {
}
