package com.weblens.messaging.contract;

import java.time.Instant;
import java.util.UUID;

public record MessageEnvelope<T>(
        UUID messageId,
        String aggregateType,
        UUID aggregateId,
        long aggregateVersion,
        String messageType,
        int contractVersion,
        UUID correlationId,
        Instant occurredAt,
        T payload
) {
}
