package com.weblens.messaging;

import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.GetResponse;
import com.weblens.common.config.CrawlerProperties;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.MountableFile;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.*;

@Testcontainers
class RabbitScanCommandPublisherIT {
    @Container static final GenericContainer<?> BROKER = new GenericContainer<>("rabbitmq:4.3.6-management-alpine")
            .withExposedPorts(5672)
            .withCopyFileToContainer(MountableFile.forHostPath(Path.of("../infra/rabbitmq/definitions.json")), "/etc/rabbitmq/definitions.json")
            .withCopyFileToContainer(MountableFile.forHostPath(Path.of("../infra/rabbitmq/rabbitmq.conf")), "/etc/rabbitmq/rabbitmq.conf")
            .waitingFor(Wait.forLogMessage(".*Server startup complete.*\\n", 1));

    @Test void confirmedPersistentMessagesPreserveIdentityAcrossReconnect() throws Exception {
        var factory = admin();
        var connection = factory.newConnection();
        try (var publisher = publisher()) {
            var ch = connection.createChannel();
            ch.queuePurge("weblens.scan.commands.v1");
            var message = message("{\"messageType\":\"SCAN_REQUESTED\"}");
            publisher.publish(message);
            assertMessage(receive(ch), message);
            // Invalidated client connections must be replaced; durable messages survive app restart.
            publisher.publish(message);
            assertThat(BROKER.execInContainer("rabbitmqctl", "stop_app").getExitCode()).isZero();
            assertThat(BROKER.execInContainer("rabbitmqctl", "start_app").getExitCode()).isZero();
            try (var recovered = factory.newConnection(); var recoveredChannel = recovered.createChannel()) {
                assertMessage(receive(recoveredChannel), message);
                publisher.publish(message);
                assertMessage(receive(recoveredChannel), message);
            }
        } finally {
            connection.abort(); // stop_app already closed the original connection.
        }
    }

    @Test void unroutableAndOversizedCommandsAreNotReportedAsDelivered() throws Exception {
        try (var connection = admin().newConnection(); var ch = connection.createChannel(); var publisher = publisher()) {
            ch.queueUnbind("weblens.scan.commands.v1", RabbitScanCommandPublisher.EXCHANGE, "scan");
            try {
                assertThatThrownBy(() -> publisher.publish(message("{}"))).isInstanceOf(IllegalStateException.class);
            } finally {
                ch.queueBind("weblens.scan.commands.v1", RabbitScanCommandPublisher.EXCHANGE, "scan");
            }
            assertThatThrownBy(() -> publisher.publish(message("x".repeat(65_537)))).isInstanceOf(IllegalArgumentException.class);
            var valid = message("{}");
            publisher.publish(valid);
            assertMessage(receive(ch), valid);
        }
    }

    @Test void producerCannotConsumeCommands() throws Exception {
        var factory = admin();
        factory.setUsername("weblens_control"); factory.setPassword("weblens-control-local-only");
        try (var connection = factory.newConnection()) {
            var ch = connection.createChannel();
            assertThatThrownBy(() -> ch.basicGet("weblens.scan.commands.v1", true)).isInstanceOf(java.io.IOException.class);
        }
    }

    @Test void fullQueueRejectsPublicationUntilCapacityReturns() throws Exception {
        try (var connection = admin().newConnection(); var ch = connection.createChannel(); var publisher = publisher()) {
            ch.queuePurge("weblens.scan.commands.v1");
            assertThat(BROKER.execInContainer("rabbitmqctl", "set_policy", "-p", "weblens", "test-capacity",
                    "^weblens\\.scan\\.commands\\.v1$", "{\"max-length\":1}", "--apply-to", "queues").getExitCode()).isZero();
            try {
                boolean rejected = false;
                // Quorum queues may briefly overshoot the limit while flow control propagates.
                for (int i = 0; i < 20 && !rejected; i++) {
                    try { publisher.publish(message("{}")); }
                    catch (IllegalStateException expected) { rejected = true; }
                }
                assertThat(rejected).isTrue();
            } finally {
                assertThat(BROKER.execInContainer("rabbitmqctl", "clear_policy", "-p", "weblens", "test-capacity").getExitCode()).isZero();
                ch.queuePurge("weblens.scan.commands.v1");
            }
            var message = message("{}");
            publisher.publish(message);
            assertMessage(receive(ch), message);
        }
    }

    @Test void dispatcherCompletesOnlyConfirmedCommandsAndRetriesFailedRouting() throws Exception {
        try (var connection = admin().newConnection(); var ch = connection.createChannel()) {
            for (boolean routed : new boolean[]{true, false}) {
                ch.queuePurge("weblens.scan.commands.v1");
                if (!routed) ch.queueUnbind("weblens.scan.commands.v1", RabbitScanCommandPublisher.EXCHANGE, "scan");
                var messages = mock(ControlMessagingRepository.class);
                var message = message("{}");
                var claimed = new AtomicBoolean();
                var finished = new CountDownLatch(1);
                given(messages.claim(any(), eq(1), any(), any())).willAnswer(invocation ->
                        claimed.getAndSet(true) ? List.of() : List.of(message));
                given(messages.complete(eq(message), any())).willAnswer(invocation -> { finished.countDown(); return true; });
                given(messages.retry(eq(message), any(), any())).willAnswer(invocation -> { finished.countDown(); return true; });
                var endpoint = URI.create("http://127.0.0.1:1/commands");
                var crawler = new CrawlerProperties(endpoint, endpoint, "test-service-token-at-least-32-bytes",
                        Duration.ofSeconds(2), Duration.ofSeconds(10), Duration.ofSeconds(30));
                var dispatcher = new CrawlerCommandDispatcher(messages, crawler, RestClient.builder(), Clock.systemUTC(), 1, properties());
                try {
                    dispatcher.dispatch();
                    assertThat(finished.await(10, TimeUnit.SECONDS)).isTrue();
                    if (routed) {
                        verify(messages).complete(eq(message), any());
                        verify(messages, never()).retry(any(), any(), any());
                        assertMessage(receive(ch), message);
                    } else {
                        verify(messages, never()).complete(any(), any());
                        verify(messages).retry(eq(message), eq("CRAWLER_DELIVERY_FAILED"), any());
                    }
                } finally {
                    dispatcher.close();
                    if (!routed) ch.queueBind("weblens.scan.commands.v1", RabbitScanCommandPublisher.EXCHANGE, "scan");
                }
            }
        }
    }

    private RabbitScanCommandPublisher publisher() {
        return new RabbitScanCommandPublisher(properties());
    }
    private ScanCommandTransportProperties properties() {
        return new ScanCommandTransportProperties(ScanCommandTransportProperties.Transport.RABBITMQ,
                BROKER.getHost(), BROKER.getMappedPort(5672), "weblens", "weblens_control", "weblens-control-local-only", false);
    }
    private ConnectionFactory admin() {
        var factory = new ConnectionFactory(); factory.setHost(BROKER.getHost()); factory.setPort(BROKER.getMappedPort(5672));
        factory.setUsername("weblens_admin"); factory.setPassword("weblens-admin-local-only"); factory.setVirtualHost("weblens");
        factory.setAutomaticRecoveryEnabled(false); factory.setConnectionTimeout(2_000);
        return factory;
    }
    private static OutboxRecord message(String body) { return new OutboxRecord(UUID.randomUUID(), UUID.randomUUID(), body, 1, UUID.randomUUID()); }
    private static GetResponse receive(Channel ch) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        do {
            GetResponse response = ch.basicGet("weblens.scan.commands.v1", true);
            if (response != null) return response;
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("Confirmed command was not available");
    }
    private static void assertMessage(GetResponse actual, OutboxRecord expected) {
        assertThat(actual.getProps().getMessageId()).isEqualTo(expected.messageId().toString());
        assertThat(actual.getProps().getCorrelationId()).isEqualTo(expected.correlationId().toString());
        assertThat(actual.getProps().getDeliveryMode()).isEqualTo(2);
        assertThat(actual.getProps().getUserId()).isEqualTo("weblens_control");
        assertThat(new String(actual.getBody(), StandardCharsets.UTF_8)).isEqualTo(expected.payload());
    }
}
