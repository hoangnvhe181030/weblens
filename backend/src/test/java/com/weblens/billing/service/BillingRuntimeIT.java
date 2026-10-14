package com.weblens.billing.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.BDDMockito.willAnswer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.WebLensApplication;
import com.weblens.auth.dto.RegisterRequest;
import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.auth.service.AuthenticationService;
import com.weblens.billing.repository.BillingRepository;
import com.weblens.billing.repository.BillingRepository.PaymentOrder;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.website.entity.WebsiteEntity;
import jakarta.persistence.EntityManager;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/** Real HTTP, JWT/session stores and JPA transaction manager. No test-level transaction or skipped infrastructure. */
@SpringBootTest(classes = WebLensApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "server.address=127.0.0.1", "server.tomcat.threads.max=16", "server.tomcat.threads.min-spare=2",
        "spring.datasource.hikari.maximum-pool-size=8", "spring.datasource.hikari.minimum-idle=2",
        "weblens.billing.enabled=true", "weblens.billing.active-profile=sandbox-v1",
        "weblens.billing.profiles.sandbox-v1.environment=SANDBOX",
        "weblens.billing.profiles.sandbox-v1.merchant-account=TEST0001",
        "weblens.billing.profiles.sandbox-v1.hash-secret=unit-test-signing-key-not-a-credential",
        "weblens.billing.profiles.sandbox-v1.checkout-endpoint=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
        "weblens.billing.profiles.sandbox-v1.return-url=https://example.test/return",
        "weblens.billing.packages.starter.amount-minor=10000",
        "weblens.billing.packages.starter.currency=VND", "weblens.billing.packages.starter.credits=1000"
})
@ActiveProfiles("test")
@Testcontainers
// Class-owned containers cannot back a cached context after the class ends.
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class BillingRuntimeIT {
    private static final String TEST_KEY = "unit-test-signing-key-not-a-credential";
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");
    @Container static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4-alpine").withExposedPorts(6379);

    @DynamicPropertySource
    static void infrastructure(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("spring.data.redis.host", REDIS::getHost);
        registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
        registry.add("spring.data.redis.username", () -> "");
        registry.add("spring.data.redis.password", () -> "");
        registry.add("spring.data.redis.ssl.enabled", () -> false);
    }

    @LocalServerPort int port;
    @Autowired ObjectMapper json;
    @Autowired JdbcClient jdbc;
    @Autowired DataSource source;
    @Autowired PlatformTransactionManager manager;
    @Autowired EntityManager entities;
    @Autowired AuthenticationService auth;
    @Autowired PaymentTransactionService payments;
    @Autowired PaymentApplicationService application;
    @Autowired UsageReservationService usage;
    @MockitoSpyBean BillingRepository repository;

    @Test
    void runtimeUsesPostgres17FlywayAndJpaTransactionManager() {
        assertThat(jdbc.sql("show server_version").query(String.class).single()).startsWith("17.6");
        assertThat(manager).isInstanceOf(JpaTransactionManager.class);
        assertThat(((JpaTransactionManager) manager).getDataSource()).isSameAs(source);
        assertThat(jdbc.sql("select count(*) from flyway_schema_history where success").query(Integer.class).single()).isEqualTo(14);
    }

    @Test
    void realJwtOrderAndSignedHttpIpnAreOwnerScopedAndIdempotent() throws Exception {
        var user = registerHttp();
        assertThat(get("/api/v1/billing/balance", null).statusCode()).isEqualTo(401);
        assertThat(get("/api/v1/billing/balance", "not-a-jwt").statusCode()).isEqualTo(401);
        var created = post("/api/v1/billing/payment-orders", "{\"packageId\":\"starter\"}", user.token(), "http-order");
        assertThat(created.statusCode()).isEqualTo(201);
        assertThat(created.headers().firstValue("Cache-Control")).contains("no-store");
        UUID id = UUID.fromString(body(created).path("order").path("id").asText());
        var order = repository.ownedOrder(user.id(), id).orElseThrow();
        var replay = post("/api/v1/billing/payment-orders", "{\"packageId\":\"starter\"}", user.token(), "http-order");
        assertThat(replay.statusCode()).isEqualTo(200);
        assertThat(body(replay).path("order").path("id").asText()).isEqualTo(id.toString());
        assertThat(post("/api/v1/billing/payment-orders", "{\"packageId\":\"other\"}", user.token(), "http-order").statusCode()).isEqualTo(409);

        String callback = signedIpn(order.reference(), order.amountMinor(), transactionId());
        assertThat(body(get(callback.replace("vnp_Amount=1000000", "vnp_Amount=2000000"), null)).path("RspCode").asText()).isEqualTo("97");
        assertThat(body(get(callback + "&vnp_Amount=1000000", null)).path("RspCode").asText()).isEqualTo("99");
        assertThat(body(get(signedIpn(order.reference(), order.amountMinor() + 1, transactionId()), null)).path("RspCode").asText()).isEqualTo("04");
        assertThat(body(get(signedIpn(UUID.randomUUID().toString().replace("-", ""), order.amountMinor(), transactionId()), null))
                .path("RspCode").asText()).isEqualTo("01");
        try (var clients = Executors.newFixedThreadPool(8)) {
            var futures = java.util.stream.IntStream.range(0, 24)
                    .mapToObj(i -> clients.submit(() -> body(get(callback, "stale-browser-token")).path("RspCode").asText())).toList();
            var codes = new java.util.ArrayList<String>();
            for (var future : futures) codes.add(future.get(15, TimeUnit.SECONDS));
            assertThat(codes.stream().filter("00"::equals).count()).isEqualTo(1);
            assertThat(codes.stream().filter("02"::equals).count()).isEqualTo(23);
        }
        assertThat(body(get("/api/v1/billing/balance", user.token())).path("balanceCredits").asLong()).isEqualTo(1_000);
        assertThat(body(get("/api/v1/billing/ledger", user.token())).size()).isEqualTo(1);
        var stranger = registerHttp();
        assertThat(get("/api/v1/billing/payment-orders/" + id, stranger.token()).statusCode()).isEqualTo(404);
        assertThat(body(get("/api/v1/billing/ledger", stranger.token())).isEmpty()).isTrue();
        assertThat(body(post("/api/v1/billing/payment-orders", "{\"packageId\":\"starter\"}", user.token(), "http-order"))
                .path("checkoutUrl").isNull()).isTrue();
        reconciled(user.id(), 1_000, 0, 1);
    }

    @Test
    void revokedRealSessionCannotAccessBilling() throws Exception {
        var issued = auth.register(new RegisterRequest(UUID.randomUUID() + "@example.test", "strong-test-password-2026", "Billing test"));
        String token = issued.response().accessToken();
        assertThat(get("/api/v1/billing/balance", token).statusCode()).isEqualTo(200);
        auth.logout(issued.refreshToken(), issued.csrfToken());
        assertThat(get("/api/v1/billing/balance", token).statusCode()).isEqualTo(401);
        assertThat(post("/api/v1/billing/payment-orders", "{\"packageId\":\"starter\"}", token, "revoked").statusCode()).isEqualTo(401);
        assertThat(rows("payment_orders", "owner_id", issued.response().user().id())).isZero();
    }

    @Test
    void jpaUserAndJdbcOrderCommitOrRollbackTogether() {
        UUID aborted = UUID.randomUUID();
        assertThatThrownBy(() -> transaction().executeWithoutResult(status -> {
            persistUser(aborted);
            payments.create(aborted, "starter", "mixed");
            throw new IllegalStateException("Injected rollback after JPA and JDBC writes");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(rows("users", "id", aborted)).isZero();
        assertThat(rows("payment_orders", "owner_id", aborted)).isZero();
        assertThat(rows("credit_accounts", "owner_id", aborted)).isZero();
        UUID committed = UUID.randomUUID();
        transaction().executeWithoutResult(status -> {
            persistUser(committed);
            payments.create(committed, "starter", "mixed");
        });
        assertThat(rows("users", "id", committed)).isEqualTo(1);
        assertThat(rows("payment_orders", "owner_id", committed)).isEqualTo(1);
    }

    @Test
    void jpaScanAndJdbcReservationShareOneAtomicTransaction() throws Exception {
        var user = registerHttp();
        var order = payments.create(user.id(), "starter", "fund").order();
        assertThat(body(get(signedIpn(order.reference(), order.amountMinor(), transactionId()), null)).path("RspCode").asText()).isEqualTo("00");
        UUID aborted = UUID.randomUUID();
        assertThatThrownBy(() -> transaction().executeWithoutResult(status -> {
            persistScan(user.id(), aborted);
            usage.reserve(user.id(), aborted, 100, 1);
            throw new IllegalStateException("Injected rollback after JPA scan and JDBC hold");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(rows("scans", "id", aborted)).isZero();
        assertThat(rows("usage_reservations", "scan_id", aborted)).isZero();
        reconciled(user.id(), 1_000, 0, 1);
        UUID committed = UUID.randomUUID();
        transaction().executeWithoutResult(status -> {
            persistScan(user.id(), committed);
            usage.reserve(user.id(), committed, 100, 1);
        });
        assertThat(rows("scans", "id", committed)).isEqualTo(1);
        assertThat(rows("usage_reservations", "scan_id", committed)).isEqualTo(1);
        reconciled(user.id(), 1_000, 100, 2);
    }

    @Test
    void httpLockTimeoutDoesNotAcknowledgeOrLeavePartialCredit() throws Exception {
        var user = registerHttp();
        var order = payments.create(user.id(), "starter", "lock").order();
        String callback = signedIpn(order.reference(), order.amountMinor(), transactionId());
        try (var holder = source.getConnection()) {
            holder.setAutoCommit(false);
            try (var lock = holder.prepareStatement("select owner_id from credit_accounts where owner_id=? for no key update")) {
                lock.setObject(1, user.id());
                try (var row = lock.executeQuery()) { assertThat(row.next()).isTrue(); }
            }
            long started = System.nanoTime();
            assertThat(body(get(callback, null)).path("RspCode").asText()).isEqualTo("99");
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).isBetween(3_000L, 8_000L);
            assertThat(payments.order(user.id(), order.id()).status()).isEqualTo("PENDING");
            reconciled(user.id(), 0, 0, 0);
            holder.rollback();
        }
        assertThat(body(get(callback, null)).path("RspCode").asText()).isEqualTo("00");
        reconciled(user.id(), 1_000, 0, 1);
    }

    @Test
    void databaseConnectionLostAtCommitReturnsRetryAndRollsBackAllWrites() throws Exception {
        var user = registerHttp();
        var order = payments.create(user.id(), "starter", "commit-failure").order();
        String callback = signedIpn(order.reference(), order.amountMinor(), transactionId());
        willAnswer(invocation -> {
            Object result = invocation.callRealMethod();
            int backend = jdbc.sql("select pg_backend_pid()").query(Integer.class).single();
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void beforeCommit(boolean readOnly) {
                    try (var killer = source.getConnection(); var statement = killer.prepareStatement("select pg_terminate_backend(?)")) {
                        statement.setInt(1, backend);
                        try (var row = statement.executeQuery()) { assertThat(row.next() && row.getBoolean(1)).isTrue(); }
                    } catch (java.sql.SQLException exception) { throw new IllegalStateException("Test connection termination failed", exception); }
                }
            });
            return result;
        }).given(repository).credit(org.mockito.ArgumentMatchers.argThat(value -> value.id().equals(order.id())),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.nullable(Instant.class), org.mockito.ArgumentMatchers.any(Instant.class));
        assertThat(body(get(callback, null)).path("RspCode").asText()).isEqualTo("99");
        assertThat(payments.order(user.id(), order.id()).status()).isEqualTo("PENDING");
        reconciled(user.id(), 0, 0, 0);
        org.mockito.Mockito.reset(repository);
        assertThat(body(get(callback, null)).path("RspCode").asText()).isEqualTo("00");
        reconciled(user.id(), 1_000, 0, 1);
    }

    @Test
    void facadeRefusesOuterTransactionInsteadOfAcknowledgingUncommittedPayment() throws Exception {
        var user = registerHttp();
        var order = payments.create(user.id(), "starter", "outer").order();
        String query = signedIpn(order.reference(), order.amountMinor(), transactionId()).split("\\?", 2)[1];
        Map<String, java.util.List<String>> decoded = new java.util.LinkedHashMap<>();
        for (String field : query.split("&")) {
            String[] pair = field.split("=", 2);
            decoded.put(pair[0], java.util.List.of(java.net.URLDecoder.decode(pair[1], StandardCharsets.UTF_8)));
        }
        assertThatThrownBy(() -> transaction().executeWithoutResult(status -> application.ipn("sandbox-v1", decoded)))
                .isInstanceOf(IllegalTransactionStateException.class);
        assertThatThrownBy(() -> transaction().executeWithoutResult(status -> application.create(user.id(), "starter", "outer-create", "127.0.0.1")))
                .isInstanceOf(IllegalTransactionStateException.class);
        assertThat(rows("payment_orders", "owner_id", user.id())).isEqualTo(1);
        reconciled(user.id(), 0, 0, 0);
    }

    @Test void killedBeforeCommitRollsBackAndRestartCreditsOnce() throws Exception { crash("BEFORE_COMMIT", false); }
    @Test void killedAfterCommitBeforeHttpAckReplaysWithoutSecondCredit() throws Exception { crash("AFTER_COMMIT", true); }

    private void crash(String point, boolean committed) throws Exception {
        var user = registerHttp();
        var order = payments.create(user.id(), "starter", point).order();
        String callback = signedIpn(order.reference(), order.amountMinor(), transactionId());
        Process child = child(point, order.id());
        try (var readers = Executors.newSingleThreadExecutor(); var client = HttpClient.newHttpClient()) {
            try {
                var output = child.inputReader(StandardCharsets.UTF_8);
                int childPort = Integer.parseInt(readers.submit(() -> marker(output, "BILLING_CHILD_READY ")).get(45, TimeUnit.SECONDS));
                var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + childPort + callback)).timeout(Duration.ofSeconds(60)).GET().build();
                var pending = client.sendAsync(request, HttpResponse.BodyHandlers.ofString());
                assertThat(readers.submit(() -> marker(output, "BILLING_CRASH_READY ")).get(15, TimeUnit.SECONDS)).isEqualTo(point);
                assertThat(pending.isDone()).isFalse();
                reconciled(user.id(), committed ? 1_000 : 0, 0, committed ? 1 : 0);
                child.destroyForcibly();
                assertThat(child.waitFor(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS)).isInstanceOf(java.util.concurrent.ExecutionException.class);
            } finally { stop(child); }
        }
        // Restart a fresh full application against the same durable test data, not an in-memory replay.
        Process restarted = child("NONE", order.id());
        try (var readers = Executors.newSingleThreadExecutor(); var client = HttpClient.newHttpClient()) {
            try {
                int childPort = Integer.parseInt(readers.submit(() -> marker(restarted.inputReader(StandardCharsets.UTF_8), "BILLING_CHILD_READY "))
                        .get(45, TimeUnit.SECONDS));
                var response = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + childPort + callback))
                        .timeout(Duration.ofSeconds(15)).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);
                assertThat(body(response).path("RspCode").asText()).isEqualTo(committed ? "02" : "00");
                assertThat(body(get(callback, null)).path("RspCode").asText()).isEqualTo("02");
                reconciled(user.id(), 1_000, 0, 1);
                System.out.println("BILLING_JVM_CRASH point=" + point + " final_topups=1");
            } finally { stop(restarted); }
        }
    }

    private TransactionTemplate transaction() { return new TransactionTemplate(manager); }
    private void persistUser(UUID owner) {
        Instant now = Instant.now();
        String email = owner + "@example.test";
        entities.persist(new UserEntity(owner, email, email, "Mixed test", "fixture", UserStatus.ACTIVE, now, now));
        entities.flush(); entities.clear();
    }
    private void persistScan(UUID owner, UUID id) {
        UUID website = UUID.randomUUID();
        Instant now = Instant.now();
        entities.persist(new WebsiteEntity(website, owner, "Mixed test", "https://example.test/" + website, "example.test", now));
        entities.persist(new ScanEntity(id, website, owner, new ScanConfiguration(100, 3, 1_048_576, 120, 5, 3), "test-v1", null, null, now));
        entities.flush(); entities.clear();
    }
    private long rows(String table, String column, UUID id) {
        if (!java.util.Set.of("users", "payment_orders", "credit_accounts", "scans", "usage_reservations").contains(table)
                || !java.util.Set.of("id", "owner_id", "scan_id").contains(column)) throw new IllegalArgumentException();
        return jdbc.sql("select count(*) from " + table + " where " + column + "=:id").param("id", id).query(Long.class).single();
    }
    private void reconciled(UUID owner, long balance, long held, int ledgerCount) {
        assertThat(repository.balance(owner).balanceCredits()).isEqualTo(balance);
        assertThat(repository.balance(owner).heldCredits()).isEqualTo(held);
        var sums = jdbc.sql("select coalesce(sum(balance_delta),0)::bigint,coalesce(sum(held_delta),0)::bigint,count(*) from credit_ledger where owner_id=:id")
                .param("id", owner).query((rs, row) -> java.util.List.of(rs.getLong(1), rs.getLong(2), rs.getLong(3))).single();
        assertThat(sums).containsExactly(balance, held, (long) ledgerCount);
    }
    private User registerHttp() throws Exception {
        var response = post("/api/v1/auth/registrations", json.writeValueAsString(Map.of("email", UUID.randomUUID() + "@example.test",
                "password", "strong-test-password-2026", "displayName", "Billing test")), null, null);
        assertThat(response.statusCode()).isEqualTo(201);
        JsonNode result = body(response);
        return new User(UUID.fromString(result.path("user").path("id").asText()), result.path("accessToken").asText());
    }
    private record User(UUID id, String token) { @Override public String toString() { return "TestUser[redacted]"; } }
    private JsonNode body(HttpResponse<String> response) throws Exception { return json.readTree(response.body()); }
    private HttpResponse<String> get(String path, String token) throws Exception { return request(path, null, token, null); }
    private HttpResponse<String> post(String path, String body, String token, String key) throws Exception { return request(path, body, token, key); }
    private HttpResponse<String> request(String path, String body, String token, String key) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).timeout(Duration.ofSeconds(15));
        if (token != null) request.header("Authorization", "Bearer " + token);
        if (key != null) request.header("Idempotency-Key", key);
        if (body != null) request.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        else request.GET();
        try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()) {
            return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        }
    }
    private static String transactionId() { return Long.toString(java.util.concurrent.ThreadLocalRandom.current().nextLong(1, 1_000_000_000_000_000L)); }
    private static String signedIpn(String reference, long amount, String transactionId) throws Exception {
        var fields = new TreeMap<String, String>();
        fields.put("vnp_Amount", Long.toString(Math.multiplyExact(amount, 100))); fields.put("vnp_BankCode", "NCB");
        fields.put("vnp_OrderInfo", "WebLens credits"); fields.put("vnp_ResponseCode", "00");
        fields.put("vnp_TmnCode", "TEST0001"); fields.put("vnp_TransactionNo", transactionId);
        fields.put("vnp_TransactionStatus", "00"); fields.put("vnp_TxnRef", reference);
        String canonical = fields.entrySet().stream().map(e -> e.getKey() + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(java.util.stream.Collectors.joining("&"));
        var mac = Mac.getInstance("HmacSHA512");
        mac.init(new SecretKeySpec(TEST_KEY.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
        return "/api/v1/billing/vnpay/sandbox-v1/ipn?" + canonical + "&vnp_SecureHash="
                + HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }
    private static Process child(String point, UUID order) throws Exception {
        String executable = Path.of(System.getProperty("java.home"), "bin", System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        var builder = new ProcessBuilder(executable, "-Xmx256m", "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")), ChildApplication.class.getName()).redirectErrorStream(true);
        builder.environment().putAll(Map.of("DB_URL", POSTGRES.getJdbcUrl(), "DB_USERNAME", POSTGRES.getUsername(), "DB_PASSWORD", POSTGRES.getPassword(),
                "WEBLENS_REDIS_HOST", REDIS.getHost(), "WEBLENS_REDIS_PORT", REDIS.getMappedPort(6379).toString(),
                "WEBLENS_BILLING_ENABLED", "true", "BILLING_TEST_POINT", point, "BILLING_TEST_ORDER", order.toString()));
        builder.environment().putAll(Map.of("WEBLENS_REDIS_USERNAME", "", "WEBLENS_REDIS_PASSWORD", "", "WEBLENS_REDIS_SSL", "false",
                "WEBLENS_HIKARI_MAX_POOL_SIZE", "8", "WEBLENS_HIKARI_MIN_IDLE", "2",
                "WEBLENS_TOMCAT_MAX_THREADS", "16", "WEBLENS_TOMCAT_MIN_SPARE_THREADS", "2"));
        return builder.start();
    }
    private static String marker(java.io.BufferedReader output, String prefix) throws Exception {
        for (String line; (line = output.readLine()) != null;) if (line.startsWith(prefix)) return line.substring(prefix.length());
        throw new IllegalStateException("Child exited before " + prefix.strip());
    }
    private static void stop(Process process) throws InterruptedException {
        if (process.isAlive()) { process.destroyForcibly(); assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue(); }
    }

    public static class ChildApplication {
        public static void main(String[] args) {
            var billing = new java.util.HashMap<String, Object>();
            billing.put("server.port", 0); billing.put("server.address", "127.0.0.1"); billing.put("spring.main.banner-mode", "off");
            billing.put("weblens.billing.active-profile", "sandbox-v1");
            billing.put("weblens.billing.profiles.sandbox-v1.environment", "SANDBOX");
            billing.put("weblens.billing.profiles.sandbox-v1.merchant-account", "TEST0001");
            billing.put("weblens.billing.profiles.sandbox-v1.hash-secret", TEST_KEY);
            billing.put("weblens.billing.profiles.sandbox-v1.checkout-endpoint", "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html");
            billing.put("weblens.billing.profiles.sandbox-v1.return-url", "https://example.test/return");
            billing.put("weblens.billing.packages.starter.amount-minor", 10_000);
            billing.put("weblens.billing.packages.starter.currency", "VND"); billing.put("weblens.billing.packages.starter.credits", 1_000);
            var context = new SpringApplicationBuilder(WebLensApplication.class, CrashConfiguration.class).profiles("test").properties(billing).run();
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            System.out.println("BILLING_CHILD_READY " + port); System.out.flush();
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    public static class CrashConfiguration {
        @Bean @Primary
        BillingRepository crashRepository(JdbcClient jdbc, Environment environment) {
            String point = environment.getRequiredProperty("BILLING_TEST_POINT");
            UUID target = UUID.fromString(environment.getRequiredProperty("BILLING_TEST_ORDER"));
            return new BillingRepository(jdbc) {
                @Override public void credit(PaymentOrder order, String providerTransaction, Instant paidAt, Instant now) {
                    super.credit(order, providerTransaction, paidAt, now);
                    if (!target.equals(order.id())) return;
                    if ("BEFORE_COMMIT".equals(point)) pause(point);
                    if ("AFTER_COMMIT".equals(point)) TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                        @Override public void afterCommit() { pause(point); }
                    });
                }
            };
        }
        private static void pause(String point) {
            System.out.println("BILLING_CRASH_READY " + point); System.out.flush();
            try { new CountDownLatch(1).await(); }
            catch (InterruptedException exception) { Thread.currentThread().interrupt(); throw new IllegalStateException("Crash probe interrupted", exception); }
        }
    }
}
