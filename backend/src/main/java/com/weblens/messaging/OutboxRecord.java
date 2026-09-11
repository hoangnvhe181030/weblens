package com.weblens.messaging;

import java.util.UUID;

public record OutboxRecord(
        UUID messageId,
        UUID correlationId,
        String payload,
        int deliveryAttempts,
        UUID leaseOwner
) {
}
