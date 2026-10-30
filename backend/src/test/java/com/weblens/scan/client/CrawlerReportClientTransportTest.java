package com.weblens.scan.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.weblens.common.config.CrawlerProperties;
import com.weblens.scan.dto.ScanPageFilter;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

@Timeout(10)
class CrawlerReportClientTransportTest {

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void silentResponseTimesOutAndClosesPhysicalSocket(boolean pages) throws Exception {
        try (var listener = listen(); var peers = Executors.newVirtualThreadPerTaskExecutor()) {
            var observed = peers.submit(() -> {
                try (var peer = listener.accept()) {
                    peer.setSoTimeout(3000);
                    String requestLine = readHeaders(peer.getInputStream());
                    long started = System.nanoTime();
                    boolean closed;
                    try {
                        closed = peer.getInputStream().read() == -1;
                    } catch (SocketTimeoutException timeout) {
                        closed = false;
                    } catch (SocketException reset) {
                        closed = true;
                    }
                    return new PeerObservation(requestLine, closed, elapsedMillis(started));
                }
            });
            var client = client(listener, Duration.ofMillis(500));
            long started = System.nanoTime();
            Throwable failure = catchThrowable(() -> {
                if (pages) {
                    client.listPages(UUID.randomUUID(), UUID.randomUUID(), 20, null,
                            new ScanPageFilter(false, null, null, null, null, null, null, null, null));
                } else {
                    client.getPage(UUID.randomUUID(), UUID.randomUUID());
                }
            });
            long elapsed = elapsedMillis(started);
            assertThat(failure).isInstanceOf(ResourceAccessException.class)
                    .hasRootCauseInstanceOf(SocketTimeoutException.class);
            var peer = observed.get(4, TimeUnit.SECONDS);
            assertThat(peer.requestLine()).startsWith(pages
                    ? "GET /internal/v1/reports/scans/" : "GET /internal/v1/reports/pages/");
            assertThat(peer.closed()).as("timeout must physically release the downstream socket").isTrue();
            assertThat(elapsed).isLessThan(3000);
            System.out.printf("transport_silent pages=%s elapsed_ms=%d peer_closed_ms=%d%n",
                    pages, elapsed, peer.closedMillis());
        }
    }

    @Test
    void readTimeoutIsNotAnAbsoluteBodyDeadline() throws Exception {
        UUID pageId = UUID.randomUUID();
        byte[] json = ("{\"id\":\"" + pageId + "\"}").getBytes(StandardCharsets.UTF_8);
        int pacedBytes = 12;
        try (var listener = listen(); var peers = Executors.newVirtualThreadPerTaskExecutor()) {
            var sent = peers.submit(() -> {
                try (var peer = listener.accept()) {
                    peer.setSoTimeout(3000);
                    readHeaders(peer.getInputStream());
                    var output = peer.getOutputStream();
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                            + (pacedBytes + json.length) + "\r\nConnection: close\r\n\r\n")
                            .getBytes(StandardCharsets.US_ASCII));
                    output.flush();
                    for (int index = 0; index < pacedBytes; index++) {
                        output.write(' ');
                        output.flush();
                        // Deliberate fault pacing, not a sleep used to await asynchronous correctness.
                        LockSupport.parkNanos(Duration.ofMillis(150).toNanos());
                    }
                    output.write(json);
                    output.flush();
                    return true;
                }
            });
            var client = client(listener, Duration.ofMillis(750));
            long started = System.nanoTime();
            var page = client.getPage(UUID.randomUUID(), pageId);
            long elapsed = elapsedMillis(started);
            assertThat(page.id()).isEqualTo(pageId);
            assertThat(sent.get(4, TimeUnit.SECONDS)).isTrue();
            assertThat(elapsed).as("socket inactivity timeout is not an absolute operation budget")
                    .isGreaterThan(750).isLessThan(5000);
            System.out.printf("transport_slow_drip read_timeout_ms=750 elapsed_ms=%d%n", elapsed);
        }
    }

    private static CrawlerReportClient client(ServerSocket listener, Duration readTimeout) {
        URI base = URI.create("http://127.0.0.1:" + listener.getLocalPort());
        return new CrawlerReportClient(RestClient.builder(), new CrawlerProperties(
                base.resolve("/internal/v1/commands/scans"), base,
                "owned-transport-fixture-token-at-least-32-bytes",
                Duration.ofMillis(500), readTimeout, Duration.ofSeconds(30)));
    }

    private static ServerSocket listen() throws IOException {
        var listener = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        listener.setSoTimeout(3000);
        return listener;
    }

    private static String readHeaders(InputStream input) throws IOException {
        var headers = new StringBuilder();
        while (headers.length() < 8192) {
            int value = input.read();
            if (value == -1) throw new IOException("Fixture peer closed before request headers");
            headers.append((char) value);
            if (headers.length() >= 4 && headers.substring(headers.length() - 4).equals("\r\n\r\n")) {
                return headers.substring(0, headers.indexOf("\r\n"));
            }
        }
        throw new IOException("Fixture request headers exceeded bound");
    }

    private static long elapsedMillis(long started) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
    }

    private record PeerObservation(String requestLine, boolean closed, long closedMillis) {}
}
