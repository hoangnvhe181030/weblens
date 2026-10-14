package com.weblens.messaging;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.weblens.common.config.CrawlerProperties;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/** Real JVM kill/restart; the HTTP receiver is a durable dedup fixture, not the crawler. */
@Testcontainers
public class DispatchCrashRecoveryIT {
    private static final String TOKEN = "local-crash-test-service-token-32-bytes";
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");
    static JdbcClient jdbc;

    @BeforeAll
    static void migrate() {
        var source = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(source).configuration(java.util.Map.of("flyway.postgresql.transactional.lock", "false"))
                .load().migrate();
        jdbc = JdbcClient.create(source);
    }

    @BeforeEach
    void clean() {
        jdbc.sql("delete from outbox_events").update();
        jdbc.sql("delete from inbox_messages").update();
    }

    @Test
    void killedAfterClaimBeforeSendRecoversWithoutLosingCommand() throws Exception { recover("BEFORE_SEND", 1); }

    @Test
    void killedAfterReceiverCommitBeforeAcknowledgementReplaysSameIdentity() throws Exception { recover("BEFORE_ACK", 2); }

    private void recover(String crashPoint, int expectedRequests) throws Exception {
        UUID message = UUID.randomUUID(), aggregate = UUID.randomUUID(), correlation = UUID.randomUUID();
        jdbc.sql("""
                insert into outbox_events(message_id,aggregate_type,aggregate_id,aggregate_version,event_type,
                  contract_version,correlation_id,payload,status,available_at,created_at)
                values(:id,'SCAN',:aggregate,1,'SCAN_REQUESTED',1,:correlation,'{}','PENDING',clock_timestamp(),clock_timestamp())
                """).param("id", message).param("aggregate", aggregate).param("correlation", correlation).update();
        var requests = new AtomicInteger();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        try (var receivers = Executors.newFixedThreadPool(2); var readers = Executors.newSingleThreadExecutor()) {
            server.setExecutor(receivers);
            server.createContext("/commands", exchange -> {
                try {
                    if (!TOKEN.equals(exchange.getRequestHeaders().getFirst("X-WebLens-Service-Token"))
                            || !message.toString().equals(exchange.getRequestHeaders().getFirst("Idempotency-Key"))
                            || !correlation.toString().equals(exchange.getRequestHeaders().getFirst("X-Correlation-ID"))) {
                        exchange.sendResponseHeaders(401, -1);
                        return;
                    }
                    byte[] hash = MessageDigest.getInstance("SHA-256").digest(exchange.getRequestBody().readAllBytes());
                    // Reuse the existing schema only inside this isolated test database.
                    jdbc.sql("""
                            insert into inbox_messages(message_id,source_service,aggregate_type,aggregate_id,
                              aggregate_version,message_type,contract_version,correlation_id,payload_sha256,
                              outcome,received_at,processed_at)
                            values(:id,'TEST_RECEIVER','SCAN',:aggregate,1,'SCAN_REQUESTED',1,:correlation,:hash,
                              'APPLIED',clock_timestamp(),clock_timestamp()) on conflict(message_id) do nothing
                            """).param("id", message).param("aggregate", aggregate).param("correlation", correlation)
                            .param("hash", hash).update();
                    assertThat(jdbc.sql("select payload_sha256 from inbox_messages where message_id=:id")
                            .param("id", message).query(byte[].class).single()).isEqualTo(hash);
                    requests.incrementAndGet();
                    exchange.sendResponseHeaders(202, -1);
                } catch (Exception exception) {
                    exchange.sendResponseHeaders(500, -1);
                } finally { exchange.close(); }
            });
            server.start();
            URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/commands");
            Process crashed = startSender(endpoint, crashPoint);
            long started = System.nanoTime();
            try {
                var ready = readers.submit(() -> {
                    var output = crashed.inputReader();
                    for (String line; (line = output.readLine()) != null;) {
                        if (line.equals("CRASH_POINT_READY")) return true;
                    }
                    return false;
                });
                assertThat(ready.get(15, TimeUnit.SECONDS)).isTrue();
                assertThat(requests.get()).isEqualTo(expectedRequests - 1);
                assertThat(jdbc.sql("select status from outbox_events where message_id=:id").param("id", message)
                        .query(String.class).single()).isEqualTo("CLAIMED");
                crashed.destroyForcibly();
                assertThat(crashed.waitFor(5, TimeUnit.SECONDS)).isTrue();
                long expiryDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
                boolean expired = false;
                while (System.nanoTime() < expiryDeadline) {
                    expired = jdbc.sql("select lease_expires_at<=clock_timestamp() from outbox_events where message_id=:id")
                            .param("id", message).query(Boolean.class).single();
                    if (expired) break;
                    Thread.sleep(50);
                }
                assertThat(expired).isTrue();
                Process restarted = startSender(endpoint, "RECOVER");
                try {
                    assertThat(restarted.waitFor(20, TimeUnit.SECONDS)).isTrue();
                    assertThat(restarted.exitValue()).isZero();
                } finally { stop(restarted); }
                assertThat(requests.get()).isEqualTo(expectedRequests);
                assertThat(jdbc.sql("select count(*) from inbox_messages where message_id=:id").param("id", message)
                        .query(Integer.class).single()).isEqualTo(1);
                assertThat(jdbc.sql("select status from outbox_events where message_id=:id").param("id", message)
                        .query(String.class).single()).isEqualTo("DELIVERED");
                assertThat(jdbc.sql("select delivery_attempts from outbox_events where message_id=:id").param("id", message)
                        .query(Integer.class).single()).isEqualTo(2);
                System.out.printf(java.util.Locale.ROOT,
                        "DISPATCH_CRASH_RECOVERY point=%s requests=%d receipts=1 attempts=2 elapsedMs=%.3f%n",
                        crashPoint, requests.get(), (System.nanoTime() - started) / 1_000_000.0);
            } finally { stop(crashed); server.stop(0); }
        }
    }

    private static Process startSender(URI endpoint, String point) throws Exception {
        String javaExecutable = Path.of(System.getProperty("java.home"), "bin",
                System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        var builder = new ProcessBuilder(javaExecutable, "-cp", System.getProperty("surefire.test.class.path",
                System.getProperty("java.class.path")), ChildSender.class.getName()).redirectErrorStream(true);
        builder.environment().putAll(java.util.Map.of("CRASH_JDBC_URL", POSTGRES.getJdbcUrl(),
                "CRASH_DB_USER", POSTGRES.getUsername(), "CRASH_DB_PASSWORD", POSTGRES.getPassword(),
                "CRASH_ENDPOINT", endpoint.toString(), "CRASH_POINT", point));
        return builder.start();
    }

    private static void stop(Process process) throws InterruptedException {
        if (process.isAlive()) { process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS); }
    }

    public static class ChildSender {
        public static void main(String[] args) throws Exception {
            var source = new DriverManagerDataSource(System.getenv("CRASH_JDBC_URL"),
                    System.getenv("CRASH_DB_USER"), System.getenv("CRASH_DB_PASSWORD"));
            var childJdbc = JdbcClient.create(source);
            var proxy = new ProxyFactory(new ControlMessagingRepository(childJdbc, new ObjectMapper()));
            proxy.addAdvice(new TransactionInterceptor(new JdbcTransactionManager(source), new AnnotationTransactionAttributeSource()));
            var durable = (ControlMessagingRepository) proxy.getProxy();
            var acknowledged = new CountDownLatch(1);
            var crashPoint = System.getenv("CRASH_POINT");
            var adapter = new ControlMessagingRepository(childJdbc, new ObjectMapper()) {
                @Override
                public List<OutboxRecord> claim(UUID owner, int limit, Duration lease, Instant now) {
                    var records = durable.claim(owner, limit, lease, now);
                    if (!records.isEmpty() && "BEFORE_SEND".equals(crashPoint)) pause();
                    return records;
                }
                @Override
                public boolean complete(OutboxRecord record, Instant now) {
                    if ("BEFORE_ACK".equals(crashPoint)) pause();
                    boolean committed = durable.complete(record, now);
                    if (committed) acknowledged.countDown();
                    return committed;
                }
                @Override
                public boolean retry(OutboxRecord record, String code, Instant now) { return durable.retry(record, code, now); }
            };
            URI endpoint = URI.create(System.getenv("CRASH_ENDPOINT"));
            var properties = new CrawlerProperties(endpoint, endpoint, TOKEN,
                    Duration.ofMillis(100), Duration.ofSeconds(2), Duration.ofSeconds(15));
            var dispatcher = new CrawlerCommandDispatcher(adapter, properties, RestClient.builder(), Clock.systemUTC(), 1);
            try {
                dispatcher.dispatch();
                if (!acknowledged.await(30, TimeUnit.SECONDS)) throw new IllegalStateException("CHILD_ACK_NOT_COMMITTED");
            } finally { dispatcher.close(); }
        }
        private static void pause() {
            System.out.println("CRASH_POINT_READY");
            System.out.flush();
            try { new CountDownLatch(1).await(); }
            catch (InterruptedException exception) { Thread.currentThread().interrupt(); throw new IllegalStateException(exception); }
        }
    }
}
