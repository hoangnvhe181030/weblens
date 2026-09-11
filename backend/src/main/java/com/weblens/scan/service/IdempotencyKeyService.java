package com.weblens.scan.service;

import com.weblens.common.exception.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

@Component
class IdempotencyKeyService {

    private static final int MAX_KEY_LENGTH = 128;

    String hashOptional(String rawKey) {
        if (rawKey == null) {
            return null;
        }
        String key = rawKey.strip();
        if (key.isEmpty() || key.length() > MAX_KEY_LENGTH) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "INVALID_IDEMPOTENCY_KEY",
                    "Invalid idempotency key",
                    "Idempotency-Key must contain between 1 and 128 characters."
            );
        }
        return hash(key);
    }

    String fingerprint(String operation, String resourceId) {
        return hash(operation + ":" + resourceId);
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 must be available", exception);
        }
    }
}
