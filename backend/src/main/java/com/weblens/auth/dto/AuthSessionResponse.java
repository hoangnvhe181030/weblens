package com.weblens.auth.dto;

import java.time.Instant;

public record AuthSessionResponse(
        UserResponse user,
        String accessToken,
        String tokenType,
        Instant expiresAt
) {
}
