package com.weblens.capture.entity;

import com.weblens.capture.model.CaptureStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

@Entity
@Table(name = "capture_requests")
public class CaptureRequestEntity {

    @Id
    private UUID id;

    @Column(name = "owner_id", nullable = false)
    private UUID ownerId;

    @Column(name = "scan_id", nullable = false)
    private UUID scanId;

    @Column(name = "page_id", nullable = false)
    private UUID pageId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private CaptureStatus status;

    @Column(name = "target_url", nullable = false, length = 8192)
    private String targetUrl;

    @Column(name = "viewport_width", nullable = false)
    private int viewportWidth;

    @Column(name = "viewport_height", nullable = false)
    private int viewportHeight;

    @Column(name = "timeout_seconds", nullable = false)
    private int timeoutSeconds;

    @Column(name = "max_total_bytes", nullable = false)
    private long maxTotalBytes;

    @Column(name = "max_resource_bytes", nullable = false)
    private long maxResourceBytes;

    @Column(name = "max_network_requests", nullable = false)
    private int maxNetworkRequests;

    @Column(name = "max_resource_bodies", nullable = false)
    private int maxResourceBodies;

    @Column(name = "idempotency_key_hash", length = 64)
    private String idempotencyKeyHash;

    @Column(name = "request_fingerprint_hash", length = 64)
    private String requestFingerprintHash;

    @Column(name = "remote_job_version", nullable = false)
    private long remoteJobVersion;

    @Column(name = "analytics_status", nullable = false, length = 16)
    private String analyticsStatus = "PENDING";

    @Column(name = "analytics_expected_count", nullable = false)
    private int analyticsExpectedCount;

    @Column(name = "analytics_published_count", nullable = false)
    private int analyticsPublishedCount;

    @Column(name = "object_count", nullable = false)
    private int objectCount;

    @Column(name = "total_object_bytes", nullable = false)
    private long totalObjectBytes;

    @Column(name = "terminal_code", length = 64)
    private String terminalCode;

    @Column(name = "terminal_message", length = 500)
    private String terminalMessage;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "cancellation_requested_at")
    private Instant cancellationRequestedAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    @Column(nullable = false)
    private long version;

    protected CaptureRequestEntity() {
    }

    public CaptureRequestEntity(
            UUID id,
            UUID ownerId,
            UUID scanId,
            UUID pageId,
            String targetUrl,
            String idempotencyKeyHash,
            String requestFingerprintHash,
            Instant now
    ) {
        this.id = id;
        this.ownerId = ownerId;
        this.scanId = scanId;
        this.pageId = pageId;
        this.status = CaptureStatus.QUEUED;
        this.targetUrl = targetUrl;
        this.viewportWidth = 1365;
        this.viewportHeight = 768;
        this.timeoutSeconds = 30;
        this.maxTotalBytes = 52_428_800;
        this.maxResourceBytes = 10_485_760;
        this.maxNetworkRequests = 500;
        this.maxResourceBodies = 100;
        this.idempotencyKeyHash = idempotencyKeyHash;
        this.requestFingerprintHash = requestFingerprintHash;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public boolean applyRemote(
            long remoteVersion,
            String rawStatus,
            int expected,
            int published,
            int objects,
            long objectBytes,
            String code,
            String message,
            Instant now
    ) {
        if (remoteVersion <= remoteJobVersion || status.isTerminal()) {
            return false;
        }
        CaptureStatus next = CaptureStatus.valueOf(rawStatus.toUpperCase(Locale.ROOT));
        if (expected < 0 || published < 0 || published > expected || objects < 0 || objectBytes < 0) {
            throw new IllegalArgumentException("Capture counters are inconsistent");
        }
        status = next;
        if ((next == CaptureStatus.RUNNING || next == CaptureStatus.INDEXING) && startedAt == null) {
            startedAt = now;
        }
        if (next.isTerminal()) {
            finishedAt = now;
            terminalCode = emptyToNull(code);
            terminalMessage = emptyToNull(message);
        }
        analyticsExpectedCount = expected;
        analyticsPublishedCount = published;
        analyticsStatus = published == expected && next.isTerminal() ? "READY"
                : published < expected ? "INDEXING" : "PENDING";
        objectCount = objects;
        totalObjectBytes = objectBytes;
        remoteJobVersion = remoteVersion;
        updatedAt = now;
        return true;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    public UUID getId() { return id; }
    public UUID getOwnerId() { return ownerId; }
    public UUID getScanId() { return scanId; }
    public UUID getPageId() { return pageId; }
    public CaptureStatus getStatus() { return status; }
    public String getTargetUrl() { return targetUrl; }
    public int getViewportWidth() { return viewportWidth; }
    public int getViewportHeight() { return viewportHeight; }
    public int getTimeoutSeconds() { return timeoutSeconds; }
    public long getMaxTotalBytes() { return maxTotalBytes; }
    public long getMaxResourceBytes() { return maxResourceBytes; }
    public int getMaxNetworkRequests() { return maxNetworkRequests; }
    public int getMaxResourceBodies() { return maxResourceBodies; }
    public String getIdempotencyKeyHash() { return idempotencyKeyHash; }
    public String getRequestFingerprintHash() { return requestFingerprintHash; }
    public long getRemoteJobVersion() { return remoteJobVersion; }
    public String getAnalyticsStatus() { return analyticsStatus; }
    public int getAnalyticsExpectedCount() { return analyticsExpectedCount; }
    public int getAnalyticsPublishedCount() { return analyticsPublishedCount; }
    public int getObjectCount() { return objectCount; }
    public long getTotalObjectBytes() { return totalObjectBytes; }
    public String getTerminalCode() { return terminalCode; }
    public String getTerminalMessage() { return terminalMessage; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
}
