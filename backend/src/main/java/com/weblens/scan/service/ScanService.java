package com.weblens.scan.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.config.ScanLimitProperties;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.ScanRequestedPayload;
import com.weblens.messaging.contract.ScanCancelPayload;
import com.weblens.scan.dto.EffectiveScanConfigResponse;
import com.weblens.scan.dto.ScanProgressResponse;
import com.weblens.scan.dto.ScanResponse;
import com.weblens.scan.dto.TerminalReasonResponse;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanNotCancellableException;
import com.weblens.scan.model.ScanStatus;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.service.WebsiteAccessService;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.EnumSet;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class ScanService {

    private static final int MAX_PAGE_SIZE = 100;
    private static final int MAX_ACTIVE_SCANS_PER_USER = 3;
    private static final EnumSet<ScanStatus> ACTIVE_STATUSES = EnumSet.of(
            ScanStatus.QUEUED, ScanStatus.RUNNING, ScanStatus.CANCEL_REQUESTED
    );
    private static final String CREATE_OPERATION = "create-scan-v1";
    private static final String COLLECTOR_VERSION = "crawler-v1";

    private final ScanRepository scans;
    private final WebsiteAccessService websiteAccess;
    private final CurrentUserService currentUsers;
    private final ScanLimitProperties limits;
    private final IdempotencyKeyService idempotencyKeys;
    private final ControlMessagingRepository messages;
    private final Clock clock;

    public ScanService(
            ScanRepository scans,
            WebsiteAccessService websiteAccess,
            CurrentUserService currentUsers,
            ScanLimitProperties limits,
            IdempotencyKeyService idempotencyKeys,
            ControlMessagingRepository messages,
            Clock clock
    ) {
        this.scans = scans;
        this.websiteAccess = websiteAccess;
        this.currentUsers = currentUsers;
        this.limits = limits;
        this.idempotencyKeys = idempotencyKeys;
        this.messages = messages;
        this.clock = clock;
    }

    @Transactional
    public CreateScanResult create(
            UUID userId,
            UUID websiteId,
            String rawIdempotencyKey,
            UUID correlationId
    ) {
        currentUsers.lockActive(userId);
        WebsiteAccessService.WebsiteTargetSnapshot website = websiteAccess.lockOwnedActive(userId, websiteId);

        String keyHash = idempotencyKeys.hashOptional(rawIdempotencyKey);
        String fingerprint = keyHash == null
                ? null
                : idempotencyKeys.fingerprint(CREATE_OPERATION, websiteId.toString());
        if (keyHash != null) {
            ScanEntity existing = scans.findByRequestedByUserIdAndIdempotencyKeyHash(userId, keyHash).orElse(null);
            if (existing != null) {
                return replay(existing, fingerprint);
            }
        }

        if (scans.existsByWebsiteIdAndRequestedByUserIdAndStatusIn(
                websiteId, userId, ACTIVE_STATUSES
        )) {
            throw new ConflictException(
                    "WEBSITE_SCAN_ALREADY_ACTIVE",
                    "The website already has an active scan."
            );
        }
        if (scans.countByRequestedByUserIdAndStatusIn(userId, ACTIVE_STATUSES)
                >= MAX_ACTIVE_SCANS_PER_USER) {
            throw new ConflictException(
                    "ACTIVE_SCAN_QUOTA_EXCEEDED",
                    "A user can run at most three scans at the same time."
            );
        }

        Instant now = clock.instant();
        ScanEntity scan = new ScanEntity(
                UUID.randomUUID(),
                websiteId,
                userId,
                configuration(),
                COLLECTOR_VERSION,
                keyHash,
                fingerprint,
                now
        );
        scans.saveAndFlush(scan);
		messages.enqueue(new MessageEnvelope<>(
				UUID.randomUUID(),
				"SCAN",
				scan.getId(),
				scan.getVersion(),
				"SCAN_REQUESTED",
				1,
				correlationId,
				now,
				new ScanRequestedPayload(
						scan.getId(), userId, website.websiteId(), website.canonicalUrl(), website.hostname(),
						scan.getMaxPages(), scan.getMaxDepth(), scan.getMaxResponseBytes(),
						scan.getMaxDurationSeconds(), scan.getMaxRedirects(), scan.getConcurrency(),
						scan.getCollectorVersion()
				)
		));
        return new CreateScanResult(toResponse(scan), false);
    }

    public PageResponse<ScanResponse> list(UUID userId, UUID websiteId, int page, int size) {
        currentUsers.requireActive(userId);
        websiteAccess.requireOwnedActive(userId, websiteId);
        PageRequest pageable = PageRequest.of(
                page,
                boundedSize(size),
                Sort.by(Sort.Direction.DESC, "createdAt").and(Sort.by(Sort.Direction.DESC, "id"))
        );
        Page<ScanEntity> result = scans.findAllByWebsiteIdAndRequestedByUserId(websiteId, userId, pageable);
        return PageResponse.from(result.map(this::toResponse));
    }

    public ScanResponse get(UUID userId, UUID scanId) {
        currentUsers.requireActive(userId);
        return toResponse(scans.findByIdAndRequestedByUserId(scanId, userId).orElseThrow(ScanService::notFound));
    }

    @Transactional
    public CancelScanResult cancel(UUID userId, UUID scanId, UUID correlationId) {
        currentUsers.requireActive(userId);
        ScanEntity scan = scans.findByIdAndRequestedByUserIdForUpdate(scanId, userId)
                .orElseThrow(ScanService::notFound);
        try {
			Instant now = clock.instant();
            boolean newlyAccepted = scan.requestCancellation(now);
			if (newlyAccepted) {
				scans.saveAndFlush(scan);
				messages.enqueue(new MessageEnvelope<>(
						UUID.randomUUID(), "SCAN", scan.getId(), scan.getVersion(),
						"SCAN_CANCEL_REQUESTED", 1, correlationId, now,
						new ScanCancelPayload(scan.getId(), userId, now)
				));
			}
            return new CancelScanResult(toResponse(scan), newlyAccepted);
        } catch (ScanNotCancellableException exception) {
            throw new ConflictException("SCAN_NOT_CANCELLABLE", exception.getMessage());
        }
    }

    private CreateScanResult replay(ScanEntity existing, String expectedFingerprint) {
        if (!java.util.Objects.equals(existing.getRequestFingerprintHash(), expectedFingerprint)) {
            throw new ConflictException(
                    "IDEMPOTENCY_KEY_REUSED",
                    "The idempotency key was already used for a different scan request."
            );
        }
        return new CreateScanResult(toResponse(existing), true);
    }

    private ScanResponse toResponse(ScanEntity scan) {
        Long durationMs = durationMs(scan);
        TerminalReasonResponse terminalReason = scan.getTerminalCode() == null
                ? null
                : new TerminalReasonResponse(scan.getTerminalCode(), scan.getTerminalMessage());
        return new ScanResponse(
                scan.getId(),
                scan.getWebsiteId(),
                scan.getStatus(),
                scan.getCreatedAt(),
                scan.getStartedAt(),
                scan.getFinishedAt(),
                durationMs,
                new ScanProgressResponse(
                        scan.progress().discovered(),
                        scan.progress().queued(),
                        scan.progress().processed(),
                        scan.progress().succeeded(),
                        scan.progress().failed(),
                        scan.progress().limit()
                ),
                new EffectiveScanConfigResponse(
                        scan.getMaxPages(),
                        scan.getMaxDepth(),
                        scan.getMaxResponseBytes(),
                        scan.getMaxDurationSeconds(),
                        scan.getMaxRedirects(),
                        scan.getConcurrency()
                ),
                scan.getCollectorVersion(),
                0,
                terminalReason
        );
    }

    private Long durationMs(ScanEntity scan) {
        if (scan.getStartedAt() == null) {
            return null;
        }
        Instant end = scan.getFinishedAt() == null ? clock.instant() : scan.getFinishedAt();
        return Math.max(0, Duration.between(scan.getStartedAt(), end).toMillis());
    }

    private ScanConfiguration configuration() {
        return new ScanConfiguration(
                limits.maxPages(),
                limits.maxDepth(),
                limits.maxResponseBytes(),
                limits.maxDurationSeconds(),
                limits.maxRedirects(),
                limits.concurrency()
        );
    }

    private int boundedSize(int size) {
        if (size < 1 || size > MAX_PAGE_SIZE) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_PAGE_SIZE",
                    "Invalid page size",
                    "Page size must be between 1 and 100."
            );
        }
        return size;
    }

    private static NotFoundException notFound() {
        return new NotFoundException("SCAN_NOT_FOUND", "The scan does not exist.");
    }

    public record CreateScanResult(ScanResponse response, boolean replayed) {
    }

    public record CancelScanResult(ScanResponse response, boolean newlyAccepted) {
    }
}
