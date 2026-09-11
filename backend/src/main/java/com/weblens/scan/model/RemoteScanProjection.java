package com.weblens.scan.model;

public record RemoteScanProjection(
        long remoteVersion,
        ScanStatus status,
        ScanProgress progress,
        int analyticsExpectedCount,
        int analyticsPublishedCount,
        String terminalCode,
        String terminalMessage
) {
    public RemoteScanProjection {
        if (remoteVersion < 0) {
            throw new IllegalArgumentException("Remote scan version must be non-negative");
        }
        if (status == null || progress == null) {
            throw new IllegalArgumentException("Remote scan status and progress are required");
        }
        if (analyticsExpectedCount < 0
                || analyticsPublishedCount < 0
                || analyticsPublishedCount > analyticsExpectedCount
                || analyticsExpectedCount > progress.discovered()) {
            throw new IllegalArgumentException("Remote analytics counters are inconsistent");
        }
        if (status.isTerminal() && terminalCode != null && terminalCode.isBlank()) {
            throw new IllegalArgumentException("Terminal code cannot be blank");
        }
    }
}
