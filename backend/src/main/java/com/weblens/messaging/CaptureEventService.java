package com.weblens.messaging;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.capture.entity.CaptureRequestEntity;
import com.weblens.capture.repository.CaptureRequestRepository;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.contract.CaptureEventEnvelope;
import com.weblens.messaging.contract.CaptureProgressPayload;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CaptureEventService {

    private final CaptureRequestRepository captures;
    private final ControlMessagingRepository messages;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    public CaptureEventService(
            CaptureRequestRepository captures,
            ControlMessagingRepository messages,
            ObjectMapper objectMapper,
            Clock clock
    ) {
        this.captures = captures;
        this.messages = messages;
        this.objectMapper = objectMapper;
        this.clock = clock;
    }

    @Transactional
    public ConsumeResult consume(CaptureEventEnvelope envelope) {
        validateEnvelope(envelope);
        byte[] payloadHash = payloadHash(envelope.payload());
        messages.lockInboxMessage(envelope.messageId());
        Optional<InboxRecord> existing = messages.findInbox(envelope.messageId());
        if (existing.isPresent()) {
            if (!MessageDigest.isEqual(existing.get().payloadSha256(), payloadHash)) {
                throw new ConflictException("MESSAGE_ID_COLLISION", "The message ID was reused with different content.");
            }
            return new ConsumeResult(true, "IGNORED_DUPLICATE");
        }

        CaptureProgressPayload payload = envelope.payload();
        CaptureRequestEntity capture = captures.findOwnedForUpdate(payload.captureRequestId(), payload.ownerId())
                .orElseThrow(() -> new NotFoundException("CAPTURE_NOT_FOUND", "The capture projection does not exist."));
        Instant now = clock.instant();
        boolean applied;
        try {
            applied = capture.applyRemote(
                    envelope.aggregateVersion(), payload.status(),
                    payload.analyticsExpectedCount(), payload.analyticsPublishedCount(),
                    payload.objectCount(), payload.totalObjectBytes(),
                    payload.terminalCode(), payload.terminalMessage(), now
            );
        } catch (IllegalArgumentException exception) {
            throw invalidEvent("The capture event cannot be applied.", exception);
        }
        String outcome = applied ? "APPLIED" : "IGNORED_STALE";
        messages.insertCaptureInbox(envelope, payloadHash, outcome, now);
        return new ConsumeResult(false, outcome);
    }

    private static void validateEnvelope(CaptureEventEnvelope envelope) {
        if (!"CAPTURE".equals(envelope.aggregateType())
                || !"CAPTURE_PROGRESS".equals(envelope.messageType())
                || envelope.contractVersion() != 1
                || !envelope.aggregateId().equals(envelope.payload().captureRequestId())) {
            throw invalidEvent("The event contract or aggregate identifiers are invalid.", null);
        }
    }

    private byte[] payloadHash(CaptureProgressPayload payload) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(objectMapper.writeValueAsBytes(payload));
        } catch (JsonProcessingException exception) {
            throw invalidEvent("The event payload cannot be serialized.", exception);
        } catch (java.security.NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is not available", exception);
        }
    }

    private static ApiException invalidEvent(String detail, Throwable cause) {
        return new ApiException(
                HttpStatus.UNPROCESSABLE_ENTITY, "CAPTURE_EVENT_REJECTED",
                "Capture event rejected", detail, cause
        );
    }

    public record ConsumeResult(boolean duplicate, String outcome) {
    }
}
