package com.weblens.capture.dto;

public record CaptureArtifactsResponse(
        long renderedHtmlBytes,
        long screenshotBytes
) {
}
