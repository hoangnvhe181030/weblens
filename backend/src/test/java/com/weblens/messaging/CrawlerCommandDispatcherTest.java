package com.weblens.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.sun.net.httpserver.HttpServer;
import com.weblens.common.config.CrawlerProperties;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

class CrawlerCommandDispatcherTest {
    @Test
    void realHttpDispatchPreservesIdentityAndMeasuresOneVersusFourSenders() throws Exception {
        for (int round = 1; round <= 3; round++) {
            for (int concurrency : new int[]{1, 4}) run(concurrency, round);
        }
    }

    private static void run(int concurrency, int round) throws Exception {
        int count = 50;
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var identities = ConcurrentHashMap.<String>newKeySet();
        var completed = new CountDownLatch(count);
        var timestamps = new java.util.concurrent.ConcurrentLinkedQueue<Long>();
        var sequence = new AtomicInteger();
        var messages = mock(ControlMessagingRepository.class);
        long started = System.nanoTime();
        given(messages.claim(any(), eq(1), any(), any())).willAnswer(invocation -> {
            if (sequence.getAndIncrement() >= count) return List.of();
            return List.of(new OutboxRecord(UUID.randomUUID(), UUID.randomUUID(), "{}", 1, invocation.getArgument(0)));
        });
        given(messages.complete(any(), any())).willAnswer(invocation -> {
            timestamps.add(System.nanoTime() - started);
            completed.countDown();
            return true;
        });
        try (var receivers = Executors.newFixedThreadPool(4)) {
            server.setExecutor(receivers);
            server.createContext("/commands", exchange -> {
                try {
                    if (!"test-service-token-at-least-32-bytes".equals(exchange.getRequestHeaders().getFirst("X-WebLens-Service-Token"))
                            || exchange.getRequestHeaders().getFirst("X-Correlation-ID") == null
                            || !identities.add(exchange.getRequestHeaders().getFirst("Idempotency-Key"))) {
                        exchange.sendResponseHeaders(422, -1);
                    } else {
                        exchange.getRequestBody().readAllBytes();
                        Thread.sleep(20);
                        exchange.sendResponseHeaders(202, -1);
                    }
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                } finally { exchange.close(); }
            });
            server.start();
            URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/commands");
            var properties = new CrawlerProperties(endpoint, endpoint, "test-service-token-at-least-32-bytes",
                    Duration.ofMillis(500), Duration.ofSeconds(2), Duration.ofSeconds(30));
            var dispatcher = new CrawlerCommandDispatcher(messages, properties, RestClient.builder(), Clock.systemUTC(), concurrency);
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (completed.getCount() > 0 && System.nanoTime() < deadline) {
                    dispatcher.dispatch();
                    completed.await(10, TimeUnit.MILLISECONDS);
                }
                assertThat(completed.getCount()).isZero();
                assertThat(identities).hasSize(count);
                verify(messages, never()).retry(any(), any(), any());
                var sorted = timestamps.stream().sorted().toList();
                double p95 = sorted.get((int) Math.ceil(count * 0.95) - 1) / 1_000_000.0;
                System.out.printf(Locale.ROOT,
                        "DISPATCH_LOCAL_BENCHMARK round=%d senders=%d commands=%d delivered=%d p95Ms=%.3f totalMs=%.3f%n",
                        round, concurrency, count, count, p95, sorted.getLast() / 1_000_000.0);
            } finally { dispatcher.close(); server.stop(0); }
        }
    }
}
