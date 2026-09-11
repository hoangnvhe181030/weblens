package com.weblens.common.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("weblens.security.jwt")
public record JwtProperties(
        @NotBlank String secret,
        @NotBlank String issuer,
        @NotBlank String audience,
        @NotNull Duration accessTtl,
        @NotNull Duration refreshTtl
) {
    public JwtProperties {
        if (accessTtl != null && (accessTtl.isZero() || accessTtl.isNegative())) {
            throw new IllegalArgumentException("Access token TTL must be positive");
        }
        if (refreshTtl != null && (refreshTtl.isZero() || refreshTtl.isNegative())) {
            throw new IllegalArgumentException("Refresh token TTL must be positive");
        }
        if (accessTtl != null && refreshTtl != null && refreshTtl.compareTo(accessTtl) <= 0) {
            throw new IllegalArgumentException("Refresh token TTL must be greater than access token TTL");
        }
    }
}
