package com.weblens.scan.dto;

import java.util.UUID;

public record FindingResponse(
        UUID id,
        String severity,
        String title,
        String description,
        String evidence
) {
}
