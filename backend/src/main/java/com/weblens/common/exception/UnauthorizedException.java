package com.weblens.common.exception;

import org.springframework.http.HttpStatus;

public final class UnauthorizedException extends ApiException {
    public UnauthorizedException(String code, String detail) {
        super(HttpStatus.UNAUTHORIZED, code, "Authentication failed", detail);
    }
}
