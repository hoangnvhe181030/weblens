package com.weblens.messaging;

import com.weblens.common.config.CrawlerProperties;
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
@ConditionalOnProperty(prefix = "weblens.crawler", name = "dispatch-enabled", havingValue = "true", matchIfMissing = true)
public class CrawlerCommandDispatcher {

    private static final Logger LOGGER = LoggerFactory.getLogger(CrawlerCommandDispatcher.class);
    private static final int CLAIM_LIMIT = 25;

    private final ControlMessagingRepository messages;
    private final CrawlerProperties properties;
    private final RestClient client;
    private final Clock clock;
    private final UUID workerId = UUID.randomUUID();

    public CrawlerCommandDispatcher(
            ControlMessagingRepository messages,
            CrawlerProperties properties,
            RestClient.Builder restClientBuilder,
            Clock clock
    ) {
        this.messages = messages;
        this.properties = properties;
        this.clock = clock;
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        this.client = restClientBuilder.clone().requestFactory(requestFactory).build();
    }

    @Scheduled(fixedDelayString = "${weblens.crawler.dispatch-poll-interval:PT0.5S}")
    public void dispatch() {
        for (OutboxRecord message : messages.claim(
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
                LOGGER.warn("Outbox acknowledgement lost its lease: messageId={}", message.messageId());
            }
        } catch (RuntimeException exception) {
            LOGGER.warn("Crawler command delivery failed: messageId={}, type={}",
                    message.messageId(), exception.getClass().getSimpleName());
            messages.retry(message, "CRAWLER_DELIVERY_FAILED", clock.instant());
        }
    }
}
