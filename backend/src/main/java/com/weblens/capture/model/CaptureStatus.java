package com.weblens.capture.model;

public enum CaptureStatus {
    QUEUED,
    DISPATCHED,
    RUNNING,
    CANCEL_REQUESTED,
    INDEXING,
    COMPLETED,
    PARTIAL_SUCCESS,
    FAILED,
    CANCELLED;

    public boolean isTerminal() {
        return this == COMPLETED || this == PARTIAL_SUCCESS || this == FAILED || this == CANCELLED;
    }
}
