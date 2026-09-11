package com.weblens.auth.model;

import java.util.Locale;

public record EmailAddress(String value) {

    public EmailAddress {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Email must not be blank");
        }
        value = value.strip().toLowerCase(Locale.ROOT);
    }

    public static EmailAddress of(String rawEmail) {
        return new EmailAddress(rawEmail);
    }
}
