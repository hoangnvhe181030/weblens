package com.weblens.common.config;

import jakarta.validation.constraints.NotEmpty;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("weblens.security.cors")
public record CorsProperties(@NotEmpty List<String> allowedOrigins) {
    public CorsProperties {
        allowedOrigins = List.copyOf(allowedOrigins);
        if (allowedOrigins.stream().anyMatch(origin -> "*".equals(origin.strip()))) {
            throw new IllegalArgumentException("Wildcard CORS origins are not allowed with credentialed requests");
        }
    }
}
