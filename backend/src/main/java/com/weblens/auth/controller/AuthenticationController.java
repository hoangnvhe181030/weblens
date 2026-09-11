package com.weblens.auth.controller;

import com.weblens.auth.dto.AuthSessionResponse;
import com.weblens.auth.dto.LoginRequest;
import com.weblens.auth.dto.RegisterRequest;
import com.weblens.auth.security.AuthCookieFactory;
import com.weblens.auth.service.AuthenticationService;
import com.weblens.auth.service.IssuedAuthentication;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
@Tag(name = "Authentication")
public class AuthenticationController {

    private final AuthenticationService authentication;
    private final AuthCookieFactory cookies;

    public AuthenticationController(AuthenticationService authentication, AuthCookieFactory cookies) {
        this.authentication = authentication;
        this.cookies = cookies;
    }

    @PostMapping("/registrations")
    @Operation(summary = "Register a user and establish a token session")
    ResponseEntity<AuthSessionResponse> register(@Valid @RequestBody RegisterRequest request) {
        return response(authentication.register(request), HttpStatus.CREATED);
    }

    @PostMapping("/sessions")
    @Operation(summary = "Authenticate and establish a token session")
    ResponseEntity<AuthSessionResponse> login(@Valid @RequestBody LoginRequest request) {
        return response(authentication.login(request), HttpStatus.OK);
    }

    @PostMapping("/token-refreshes")
    @Operation(summary = "Rotate a refresh credential and issue a new access token")
    ResponseEntity<AuthSessionResponse> refresh(
            @CookieValue(name = AuthCookieFactory.REFRESH_COOKIE, required = false) String refreshToken,
            @RequestHeader(name = AuthCookieFactory.CSRF_HEADER, required = false) String csrfToken
    ) {
        return response(authentication.refresh(refreshToken, csrfToken), HttpStatus.OK);
    }

    @DeleteMapping("/session")
    @Operation(summary = "Revoke the current refresh session")
    ResponseEntity<Void> logout(
            @CookieValue(name = AuthCookieFactory.REFRESH_COOKIE, required = false) String refreshToken,
            @RequestHeader(name = AuthCookieFactory.CSRF_HEADER, required = false) String csrfToken
    ) {
        authentication.logout(refreshToken, csrfToken);
        return ResponseEntity.noContent()
                .header(HttpHeaders.SET_COOKIE, cookies.clearRefresh().toString(), cookies.clearCsrf().toString())
                .build();
    }

    private ResponseEntity<AuthSessionResponse> response(IssuedAuthentication issued, HttpStatus status) {
        return ResponseEntity.status(status)
                .header(
                        HttpHeaders.SET_COOKIE,
                        cookies.refresh(issued.refreshToken()).toString(),
                        cookies.csrf(issued.csrfToken()).toString()
                )
                .body(issued.response());
    }
}
