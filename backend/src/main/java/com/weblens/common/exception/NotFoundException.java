package com.weblens.common.exception;

import org.springframework.http.HttpStatus;

public final class NotFoundException extends ApiException {
    public NotFoundException(String code, String detail) {
        super(HttpStatus.NOT_FOUND, code, "Resource not found", detail);
    }
}
