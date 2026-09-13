package com.weblens.scan.dto;

public record HttpTimingResponse(
        Long dnsMillis,
        Long connectMillis,
        Long tlsMillis,
        Long ttfbMillis,
        Long totalMillis
) {
}
