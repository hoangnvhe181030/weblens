package com.weblens.common.exception;

import org.springframework.http.HttpStatus;

public final class ConflictException extends ApiException {
    public ConflictException(String code, String detail) {
        super(HttpStatus.CONFLICT, code, "Request conflicts with current state", detail);
    }
}
