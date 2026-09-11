package com.weblens.auth.security;

import java.time.Instant;

public record TokenPair(
        String accessToken,
        Instant accessExpiresAt,
        String refreshToken,
        String refreshJti,
        Instant refreshExpiresAt
) {
}
