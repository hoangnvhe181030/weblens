package com.weblens.scan.model;

public enum ScanStatus {
    QUEUED,
    RUNNING,
    CANCEL_REQUESTED,
    COMPLETED,
    PARTIAL_SUCCESS,
    FAILED,
    CANCELLED;

    public boolean isTerminal() {
        return this == COMPLETED || this == PARTIAL_SUCCESS || this == FAILED || this == CANCELLED;
    }

    public boolean isActive() {
        return this == QUEUED || this == RUNNING || this == CANCEL_REQUESTED;
    }
}
