package com.weblens.common.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("weblens.crawler")
public record CrawlerProperties(
        @NotNull URI commandUrl,
        @NotNull URI reportBaseUrl,
        @NotBlank @Size(min = 32, max = 512) String serviceToken,
        @NotNull Duration connectTimeout,
        @NotNull Duration readTimeout,
        @NotNull Duration outboxLease
) {
    public CrawlerProperties {
        if (commandUrl != null
                && (!commandUrl.isAbsolute()
                || !("http".equalsIgnoreCase(commandUrl.getScheme())
                || "https".equalsIgnoreCase(commandUrl.getScheme()))
                || commandUrl.getUserInfo() != null)) {
            throw new IllegalArgumentException("Crawler command URL must be an absolute HTTP(S) URL without userinfo");
        }
		if (reportBaseUrl != null
				&& (!reportBaseUrl.isAbsolute()
				|| !("http".equalsIgnoreCase(reportBaseUrl.getScheme())
				|| "https".equalsIgnoreCase(reportBaseUrl.getScheme()))
				|| reportBaseUrl.getUserInfo() != null)) {
			throw new IllegalArgumentException("Crawler report base URL must be an absolute HTTP(S) URL without userinfo");
		}
        requireRange(connectTimeout, Duration.ofMillis(100), Duration.ofSeconds(30), "connectTimeout");
        requireRange(readTimeout, Duration.ofMillis(100), Duration.ofMinutes(1), "readTimeout");
        requireRange(outboxLease, Duration.ofSeconds(5), Duration.ofMinutes(5), "outboxLease");
    }

    private static void requireRange(Duration value, Duration minimum, Duration maximum, String name) {
        if (value != null && (value.compareTo(minimum) < 0 || value.compareTo(maximum) > 0)) {
            throw new IllegalArgumentException(name + " is outside the supported range");
        }
    }
}
