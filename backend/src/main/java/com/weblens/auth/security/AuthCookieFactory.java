package com.weblens.auth.security;

import com.weblens.common.config.CookieProperties;
import com.weblens.common.config.JwtProperties;
import java.time.Duration;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

@Component
public class AuthCookieFactory {

    public static final String REFRESH_COOKIE = "WEBLENS_REFRESH";
    public static final String CSRF_COOKIE = "XSRF-TOKEN";
    public static final String CSRF_HEADER = "X-XSRF-TOKEN";

    private final CookieProperties cookies;
    private final JwtProperties jwt;

    public AuthCookieFactory(CookieProperties cookies, JwtProperties jwt) {
        this.cookies = cookies;
        this.jwt = jwt;
    }

    public ResponseCookie refresh(String value) {
        return ResponseCookie.from(REFRESH_COOKIE, value)
                .httpOnly(true)
                .secure(cookies.secure())
                .sameSite("Strict")
                .path("/api/v1/auth")
                .maxAge(jwt.refreshTtl())
                .build();
    }

    public ResponseCookie csrf(String value) {
        return ResponseCookie.from(CSRF_COOKIE, value)
                .httpOnly(false)
                .secure(cookies.secure())
                .sameSite("Strict")
                .path("/")
                .maxAge(jwt.refreshTtl())
                .build();
    }

    public ResponseCookie clearRefresh() {
        return ResponseCookie.from(REFRESH_COOKIE, "")
                .httpOnly(true)
                .secure(cookies.secure())
                .sameSite("Strict")
                .path("/api/v1/auth")
                .maxAge(Duration.ZERO)
                .build();
    }

    public ResponseCookie clearCsrf() {
        return ResponseCookie.from(CSRF_COOKIE, "")
                .httpOnly(false)
                .secure(cookies.secure())
                .sameSite("Strict")
                .path("/")
                .maxAge(Duration.ZERO)
                .build();
    }
}
