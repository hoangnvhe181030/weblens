package com.weblens.messaging.contract;

import java.util.UUID;

public record CaptureRequestedPayload(
        UUID captureRequestId,
        UUID ownerId,
        UUID scanId,
        UUID pageId,
        String targetUrl,
        int viewportWidth,
        int viewportHeight,
        int timeoutSeconds,
        long maxTotalBytes,
        long maxResourceBytes,
        int maxNetworkRequests,
        int maxResourceBodies,
        String measurementProfile,
        StaticCaptureObservation staticObservation
) {
}
