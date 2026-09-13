package com.weblens.messaging.contract;

import java.util.List;

public record StaticCaptureObservation(
        String title,
        String description,
        String canonicalUrl,
        String h1,
        long links,
        long images,
        List<String> schemaOrgTypes,
        String observedAt
) {
}
