package com.weblens.auth.service;

import com.weblens.auth.dto.AuthSessionResponse;

public record IssuedAuthentication(
        AuthSessionResponse response,
        String refreshToken,
        String csrfToken
) {
}
