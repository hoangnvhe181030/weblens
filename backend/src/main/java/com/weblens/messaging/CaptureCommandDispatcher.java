package com.weblens.messaging;

import com.weblens.common.config.CaptureProperties;
import java.time.Clock;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
@ConditionalOnProperty(prefix = "weblens.capture", name = "dispatch-enabled", havingValue = "true", matchIfMissing = true)
public class CaptureCommandDispatcher {

    private static final Logger LOGGER = LoggerFactory.getLogger(CaptureCommandDispatcher.class);
    private static final int CLAIM_LIMIT = 10;

    private final ControlMessagingRepository messages;
    private final CaptureProperties properties;
    private final RestClient client;
    private final Clock clock;
    private final UUID workerId = UUID.randomUUID();

    public CaptureCommandDispatcher(
            ControlMessagingRepository messages,
            CaptureProperties properties,
            RestClient.Builder builder,
            Clock clock
    ) {
        this.messages = messages;
        this.properties = properties;
        this.clock = clock;
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        this.client = builder.clone().requestFactory(requestFactory).build();
    }

    @Scheduled(fixedDelayString = "${weblens.capture.dispatch-poll-interval:PT0.5S}")
    public void dispatch() {
        for (OutboxRecord message : messages.claimCaptures(
                workerId, CLAIM_LIMIT, properties.outboxLease(), clock.instant()
        )) {
            dispatch(message);
        }
    }

    private void dispatch(OutboxRecord message) {
        try {
            client.post()
                    .uri(properties.commandUrl())
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("X-WebLens-Service-Token", properties.serviceToken())
                    .header("X-Correlation-ID", message.correlationId().toString())
                    .header("Idempotency-Key", message.messageId().toString())
                    .body(message.payload())
                    .retrieve()
                    .toBodilessEntity();
            if (!messages.complete(message, clock.instant())) {
                LOGGER.warn("Capture outbox acknowledgement lost its lease: messageId={}", message.messageId());
            }
        } catch (RuntimeException exception) {
            LOGGER.warn("Capture command delivery failed: messageId={}, type={}",
                    message.messageId(), exception.getClass().getSimpleName());
            messages.retry(message, "CAPTURE_DELIVERY_FAILED", clock.instant());
        }
    }
}
