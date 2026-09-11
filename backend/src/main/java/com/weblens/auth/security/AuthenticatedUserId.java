package com.weblens.auth.security;

import com.weblens.common.exception.UnauthorizedException;
import java.util.UUID;
import org.springframework.security.oauth2.jwt.Jwt;

public final class AuthenticatedUserId {

    private AuthenticatedUserId() {
    }

    public static UUID from(Jwt jwt) {
        try {
            return UUID.fromString(jwt.getSubject());
        } catch (IllegalArgumentException | NullPointerException exception) {
            throw new UnauthorizedException("INVALID_ACCESS_TOKEN", "The access token subject is invalid.");
        }
    }
}
