package com.weblens.scan.model;

public final class InvalidScanTransitionException extends IllegalStateException {

    public InvalidScanTransitionException(ScanStatus current, ScanStatus next) {
        super("Scan cannot transition from " + current + " to " + next + ".");
    }
}
