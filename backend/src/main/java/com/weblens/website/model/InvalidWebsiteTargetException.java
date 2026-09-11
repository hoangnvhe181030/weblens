package com.weblens.website.model;

public final class InvalidWebsiteTargetException extends IllegalArgumentException {

    InvalidWebsiteTargetException() {
        super("The URL must be an absolute HTTP(S) URL without credentials or a fragment.");
    }
}
