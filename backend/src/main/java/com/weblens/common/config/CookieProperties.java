package com.weblens.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("weblens.security.cookies")
public record CookieProperties(boolean secure) {
}
