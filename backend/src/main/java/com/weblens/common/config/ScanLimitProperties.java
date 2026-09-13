package com.weblens.common.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("weblens.scan.limits")
public record ScanLimitProperties(
        @Min(1) @Max(1_000_000) int maxPages,
        @Min(0) @Max(10) int maxDepth,
        @Min(1024) @Max(52_428_800) long maxResponseBytes,
        @Min(1) @Max(604_800) int maxDurationSeconds,
        @Min(0) @Max(10) int maxRedirects,
        @Min(1) @Max(10_000) int concurrency
) {
}
