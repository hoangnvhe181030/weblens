package com.weblens.scan.model;

public final class ScanNotCancellableException extends IllegalStateException {

    public ScanNotCancellableException() {
        super("A completed scan cannot be cancelled.");
    }
}
