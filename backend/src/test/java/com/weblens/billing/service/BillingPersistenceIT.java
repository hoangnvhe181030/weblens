package com.weblens.billing.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.billing.config.BillingConfiguration.CreditPackage;
import com.weblens.billing.config.BillingConfiguration.Profile;
import com.weblens.billing.config.BillingConfiguration.Properties;
import com.weblens.billing.gateway.PaymentGateway.Environment;
import com.weblens.billing.gateway.PaymentGateway.Outcome;
import com.weblens.billing.gateway.PaymentGateway.VerifiedPayment;
import com.weblens.billing.model.UsageBillingPolicy.TerminalEvidence;
import com.weblens.billing.model.UsageBillingPolicy.TerminalOutcome;
import com.weblens.billing.repository.BillingRepository;
import com.weblens.billing.repository.BillingRepository.PaymentOrder;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.scan.service.IdempotencyKeyService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.IntFunction;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

/** Real committed PostgreSQL transactions; never skip when the database is unavailable. */
class BillingPersistenceIT {
    private static final String TEST_KEY = "unit-test-signing-key-not-a-credential";
    // A persistent local fixture must support reruns without deleting append-only ledger rows.
    private static final String RUN_PREFIX = Long.toString(ThreadLocalRandom.current().nextLong(100_000_000L, 1_000_000_000L));
    private static PostgreSQLContainer<?> container;
    private static JdbcClient jdbc;
    private static BillingRepository repository;
    private static PaymentTransactionService payments;
    private static UsageReservationService usage;
    private static TransactionTemplate transaction;
    private static Properties properties;
    private static CurrentUserService users;
    private static JdbcTransactionManager manager;

    @BeforeAll
    static void database() {
        String local = System.getenv("WEBLENS_BILLING_TEST_JDBC_URL");
        DriverManagerDataSource source;
        if (local != null) {
            if (!local.matches("jdbc:postgresql://127\\.0\\.0\\.1:[0-9]+/weblens_billing_test")) {
                throw new IllegalArgumentException("Billing integration requires a dedicated loopback test database");
            }
            source = new DriverManagerDataSource(local, "billing_test", "");
        } else {
            container = new PostgreSQLContainer<>("postgres:17.6-alpine");
            container.start();
            source = new DriverManagerDataSource(container.getJdbcUrl(), container.getUsername(), container.getPassword());
        }
        Flyway.configure().dataSource(source).configuration(Map.of("flyway.postgresql.transactional.lock", "false"))
                .load().migrate();
        jdbc = JdbcClient.create(source);
        System.out.println("BILLING_DATABASE_TEST version=" + jdbc.sql("show server_version").query(String.class).single());
        repository = new BillingRepository(jdbc);
        manager = new JdbcTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        transaction.setTimeout(5);
        // Use the same owner lookup/lock SQL without a JPA cache or a whole application/auth Redis context.
        users = new CurrentUserService(null) {
            @Override public void requireActive(UUID owner) {
                if (jdbc.sql("select id from users where id=:id and status='ACTIVE'").param("id", owner)
                        .query(UUID.class).optional().isEmpty()) throw new IllegalStateException("Inactive test user");
            }
            @Override public void lockActive(UUID owner) {
                if (jdbc.sql("select id from users where id=:id and status='ACTIVE' for update").param("id", owner)
                        .query(UUID.class).optional().isEmpty()) throw new IllegalStateException("Inactive test user");
            }
        };
        properties = config("sandbox-v1", 1_000);
        payments = proxy(new PaymentTransactionService(repository, users, new IdempotencyKeyService(), properties, Clock.systemUTC()));
        usage = proxy(new UsageReservationService(jdbc, repository));
    }

    @AfterAll
    static void stop() { if (container != null) container.stop(); }

    @Test
    void twoHundredDuplicateIpnsHaveOneCommittedTopup() throws Exception {
        UUID owner = owner();
        var order = create(owner, "same-order");
        var notification = payment(order, Outcome.SUCCEEDED, "10001");
        List<String> codes = parallel(200, i -> payments.accept(order.profileId(), notification));
        assertThat(codes.stream().filter("00"::equals).count()).isEqualTo(1);
        assertThat(codes.stream().filter("02"::equals).count()).isEqualTo(199);
        assertThat(repository.balance(owner).balanceCredits()).isEqualTo(1_000);
        assertThat(count("credit_ledger", owner)).isEqualTo(1);
        reconciled(owner);
    }

    @Test
    void concurrentCreateAndCatalogOrProfileSwitchReplayOriginalSnapshot() throws Exception {
        UUID owner = owner();
        var created = parallel(40, i -> payments.create(owner, "starter", "create-key"));
        assertThat(created.stream().map(value -> value.order().id()).distinct().count()).isEqualTo(1);
        assertThat(count("payment_orders", owner)).isEqualTo(1);
        var changedService = proxy(new PaymentTransactionService(repository, users, new IdempotencyKeyService(),
                config("sandbox-v2", 8_000), Clock.systemUTC()));
        var replay = changedService.create(owner, "starter", "create-key");
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.order().profileId()).isEqualTo("sandbox-v1");
        assertThat(replay.order().credits()).isEqualTo(1_000);
        assertThatThrownBy(() -> changedService.create(owner, "another", "create-key")).isInstanceOf(ConflictException.class);
    }

    @Test
    void signedFailureCanLaterBecomePaidButPaidCannotBeDowngraded() {
        UUID owner = owner();
        var order = create(owner, "late-success");
        assertThat(payments.accept(order.profileId(), payment(order, Outcome.NOT_SUCCEEDED, "0"))).isEqualTo("00");
        assertThat(repository.balance(owner).balanceCredits()).isZero();
        jdbc.sql("update payment_orders set expires_at=created_at+interval '1 second',created_at=created_at-interval '1 day' where id=:id")
                .param("id", order.id()).update();
        assertThat(payments.accept(order.profileId(), payment(order, Outcome.SUCCEEDED, "10002"))).isEqualTo("00");
        assertThat(payments.accept(order.profileId(), payment(order, Outcome.NOT_SUCCEEDED, "0"))).isEqualTo("99");
        assertThat(payments.order(owner, order.id()).status()).isEqualTo("PAID");
        reconciled(owner);
    }

    @Test
    void mismatchAndProviderTransactionReuseDoNotCreditAnotherOrder() {
        UUID owner = owner();
        var first = create(owner, "first");
        var second = create(owner, "second");
        assertThat(payments.accept("other-profile", payment(first, Outcome.SUCCEEDED, "10003"))).isEqualTo("99");
        var wrongAmount = new VerifiedPayment(first.identity(), first.reference(), "10003", first.amountMinor() + 1,
                "VND", Outcome.SUCCEEDED, null);
        assertThat(payments.accept(first.profileId(), wrongAmount)).isEqualTo("04");
        assertThat(payments.accept(first.profileId(), payment(first, Outcome.SUCCEEDED, "10003"))).isEqualTo("00");
        assertThat(payments.accept(first.profileId(), payment(first, Outcome.SUCCEEDED, "DIFFERENT"))).isEqualTo("99");
        assertThatThrownBy(() -> payments.accept(second.profileId(), payment(second, Outcome.SUCCEEDED, "10003")))
                .isInstanceOf(DataAccessException.class);
        assertThat(payments.order(owner, second.id()).status()).isEqualTo("PENDING");
        assertThat(repository.balance(owner).balanceCredits()).isEqualTo(1_000);
        reconciled(owner);
    }

    @Test
    void rollbackAfterTopupWritesAndRecreatedServiceReplayAreSafe() {
        UUID owner = owner();
        var order = create(owner, "rollback");
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> {
            assertThat(payments.accept(order.profileId(), payment(order, Outcome.SUCCEEDED, "10004"))).isEqualTo("00");
            throw new IllegalStateException("Injected crash before commit");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(repository.balance(owner).balanceCredits()).isZero();
        assertThat(count("credit_ledger", owner)).isZero();
        var restarted = proxy(new PaymentTransactionService(repository, users, new IdempotencyKeyService(), properties, Clock.systemUTC()));
        assertThat(restarted.accept(order.profileId(), payment(order, Outcome.SUCCEEDED, "10004"))).isEqualTo("00");
        assertThat(restarted.accept(order.profileId(), payment(order, Outcome.SUCCEEDED, "10004"))).isEqualTo("02");
        reconciled(owner);
    }

    @Test
    void hundredContendedReservationsCannotOverspendAndFinalizeIsIdempotent() throws Exception {
        UUID owner = fundedOwner("10005");
        List<UUID> scans = new ArrayList<>();
        for (int i = 0; i < 100; i++) scans.add(scan(owner, 100));
        var accepted = parallel(100, i -> {
            try { transaction.executeWithoutResult(status -> usage.reserve(owner, scans.get(i), 100, 1)); return scans.get(i); }
            catch (ConflictException exception) {
                assertThat(exception.code()).isEqualTo("INSUFFICIENT_CREDITS"); return null;
            }
        }).stream().filter(java.util.Objects::nonNull).toList();
        assertThat(accepted).hasSize(10);
        assertThat(repository.balance(owner).heldCredits()).isEqualTo(1_000);
        assertThat(repository.balance(owner).availableCredits()).isZero();
        UUID id = accepted.getFirst();
        terminal(id, "PARTIAL_SUCCESS", 7);
        var evidence = new TerminalEvidence(TerminalOutcome.PARTIAL_SUCCESS, 37, true);
        var settlements = parallel(50, i -> transaction.execute(status -> usage.finalizeUsage(owner, id, 7, evidence)));
        assertThat(settlements.stream().distinct().count()).isEqualTo(1);
        assertThat(repository.balance(owner).balanceCredits()).isEqualTo(963);
        assertThat(repository.balance(owner).heldCredits()).isEqualTo(900);
        assertThat(repository.balance(owner).availableCredits()).isEqualTo(63);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> usage.finalizeUsage(owner, id, 8, evidence)))
                .isInstanceOf(ConflictException.class);
        reconciled(owner);
    }

    @Test
    void reservationAndFinalizeRollbackLeaveNoPartialProjectionOrLedger() {
        UUID owner = fundedOwner("10006");
        UUID scan = scan(owner, 100);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> {
            usage.reserve(owner, scan, 100, 1);
            throw new IllegalStateException("Injected crash after reserve");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(repository.balance(owner).heldCredits()).isZero();
        assertThat(count("usage_reservations", owner)).isZero();
        transaction.executeWithoutResult(status -> usage.reserve(owner, scan, 100, 1));
        terminal(scan, "CANCELLED", 3);
        var evidence = new TerminalEvidence(TerminalOutcome.USER_CANCELLED, 10, true);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> {
            usage.finalizeUsage(owner, scan, 3, evidence);
            throw new IllegalStateException("Injected crash after finalize");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(repository.balance(owner).heldCredits()).isEqualTo(100);
        assertThat(repository.balance(owner).balanceCredits()).isEqualTo(1_000);
        transaction.executeWithoutResult(status -> usage.finalizeUsage(owner, scan, 3, evidence));
        reconciled(owner);
    }

    @Test
    void requiresTerminalEvidenceAndInternalFailureReleasesAll() {
        UUID owner = fundedOwner("10007");
        UUID scan = scan(owner, 100);
        transaction.executeWithoutResult(status -> usage.reserve(owner, scan, 100, 1));
        var evidence = new TerminalEvidence(TerminalOutcome.COMPLETED, 10, true);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> usage.finalizeUsage(owner, scan, 1, evidence)))
                .isInstanceOf(ConflictException.class);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> usage.reserve(owner, scan, 100, 2)))
                .isInstanceOf(ConflictException.class);
        terminal(scan, "FAILED", 4);
        var released = transaction.execute(status -> usage.finalizeUsage(owner, scan, 4,
                new TerminalEvidence(TerminalOutcome.INTERNAL_FAILURE, 37, false)));
        assertThat(released.chargedCredits()).isZero();
        assertThat(released.releasedCredits()).isEqualTo(100);
        assertThat(repository.balance(owner).heldCredits()).isZero();
        reconciled(owner);
    }

    @Test
    void ownerIsolationLedgerImmutabilityAndSourceForeignKeysAreEnforced() {
        UUID owner = fundedOwner("10008");
        UUID stranger = owner();
        var order = create(owner, "private");
        assertThatThrownBy(() -> payments.order(stranger, order.id())).isInstanceOf(NotFoundException.class);
        assertThat(payments.history(stranger, null, null, 100)).isEmpty();
        assertThatThrownBy(() -> jdbc.sql("update credit_ledger set balance_delta=1 where owner_id=:id").param("id", owner).update())
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.sql("delete from credit_ledger where owner_id=:id").param("id", owner).update())
                .isInstanceOf(DataAccessException.class);
        repository.ensureAccount(stranger);
        assertThatThrownBy(() -> jdbc.sql("""
                insert into credit_ledger(owner_id,operation,payment_order_id,balance_delta,held_delta)
                values (:owner,'TOPUP',:order,100,0)
                """).param("owner", stranger).param("order", order.id()).update()).isInstanceOf(DataAccessException.class);
        UUID scan = scan(owner, 100);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> usage.reserve(stranger, scan, 100, 1)))
                .isInstanceOf(NotFoundException.class);
        assertThatThrownBy(() -> usage.reserve(owner, scan, 100, 1))
                .isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
        reconciled(owner);
    }

    @Test
    void ledgerHistoryKeysetDoesNotRepeatRowsAndBoundsCursor() {
        UUID owner = fundedOwner("10009");
        var second = create(owner, "second-topup");
        payments.accept(second.profileId(), payment(second, Outcome.SUCCEEDED, "10010"));
        var firstPage = payments.history(owner, null, null, 1);
        assertThat(firstPage).hasSize(1);
        var cursor = firstPage.getFirst();
        var next = payments.history(owner, cursor.createdAt(), cursor.id(), 1);
        assertThat(next).hasSize(1);
        assertThat(next.getFirst().id()).isNotEqualTo(cursor.id());
        assertThatThrownBy(() -> payments.history(owner, null, 1L, 1)).isInstanceOf(com.weblens.common.exception.ApiException.class);
        assertThatThrownBy(() -> payments.history(owner, null, null, 101)).isInstanceOf(com.weblens.common.exception.ApiException.class);
        String plan = jdbc.sql("explain select * from payment_orders where owner_id=:owner and idempotency_key_hash=:key")
                .param("owner", owner).param("key", new IdempotencyKeyService().hashOptional("second-topup"))
                .query(String.class).list().toString();
        System.out.println("BILLING_SMALL_FIXTURE_PLAN " + plan);
    }

    @Test
    void signedFacadeAcknowledgesOnlyDurableTopupAndRejectsUnknownOrMismatchedOrders() throws Exception {
        UUID owner = owner();
        var order = create(owner, "signed-facade");
        var meters = new SimpleMeterRegistry();
        try {
            var application = new PaymentApplicationService(payments, properties, meters, Clock.systemUTC());
            assertThat(application.ipn(order.profileId(), signedIpn(UUID.randomUUID().toString().replace("-", ""),
                    order.amountMinor(), "10011")).code()).isEqualTo("01");
            assertThat(application.ipn(order.profileId(), signedIpn(order.reference(), order.amountMinor() + 1, "10011")).code())
                    .isEqualTo("04");
            var signed = signedIpn(order.reference(), order.amountMinor(), "10011");
            assertThat(application.ipn(order.profileId(), signed).code()).isEqualTo("00");
            // These reads use new connections after the proxied transaction has returned.
            assertThat(payments.order(owner, order.id()).status()).isEqualTo("PAID");
            assertThat(repository.balance(owner).balanceCredits()).isEqualTo(1_000);
            assertThat(application.ipn(order.profileId(), signed).code()).isEqualTo("02");
            assertThat(count("credit_ledger", owner)).isEqualTo(1);
            reconciled(owner);
        } finally {
            meters.close();
        }
    }

    @Test
    void orderAndAccountLockWaitsAreBoundedAndRetryAfterRollbackIsSafe() throws Exception {
        UUID owner = owner();
        var meters = new SimpleMeterRegistry();
        try {
            var application = new PaymentApplicationService(payments, properties, meters, Clock.systemUTC());
            for (boolean account : List.of(false, true)) {
                var order = create(owner, account ? "account-lock" : "order-lock");
                var signed = signedIpn(order.reference(), order.amountMinor(), account ? "10013" : "10012");
                try (var holder = manager.getDataSource().getConnection()) {
                    holder.setAutoCommit(false);
                    String sql = account ? "select owner_id from credit_accounts where owner_id=? for no key update"
                            : "select id from payment_orders where id=? for no key update";
                    try (var statement = holder.prepareStatement(sql)) {
                        statement.setObject(1, account ? owner : order.id());
                        try (var row = statement.executeQuery()) { assertThat(row.next()).isTrue(); }
                    }
                    long started = System.nanoTime();
                    assertThat(application.ipn(order.profileId(), signed).code()).isEqualTo("99");
                    long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
                    assertThat(elapsedMs).isBetween(3_000L, 8_000L);
                    assertThat(payments.order(owner, order.id()).status()).isEqualTo("PENDING");
                    assertThat(repository.balance(owner).balanceCredits()).isEqualTo(account ? 1_000 : 0);
                    holder.rollback();
                    System.out.println("BILLING_LOCK_TIMEOUT resource=" + (account ? "account" : "order") + " elapsed_ms=" + elapsedMs);
                }
                assertThat(application.ipn(order.profileId(), signed).code()).isEqualTo("00");
                assertThat(application.ipn(order.profileId(), signed).code()).isEqualTo("02");
                reconciled(owner);
            }
            assertThat(repository.balance(owner).balanceCredits()).isEqualTo(2_000);
            assertThat(count("credit_ledger", owner)).isEqualTo(2);
        } finally {
            meters.close();
        }
    }

    private static PaymentOrder create(UUID owner, String key) { return payments.create(owner, "starter", key).order(); }
    private static VerifiedPayment payment(PaymentOrder order, Outcome outcome, String transactionId) {
        return new VerifiedPayment(order.identity(), order.reference(), transactionId(transactionId), order.amountMinor(), order.currency(), outcome, Instant.now());
    }
    private static String transactionId(String suffix) { return "0".equals(suffix) ? "0" : RUN_PREFIX + suffix; }
    private static Map<String, List<String>> signedIpn(String reference, long amount, String suffix) throws Exception {
        var fields = new TreeMap<String, String>();
        fields.put("vnp_Amount", Long.toString(Math.multiplyExact(amount, 100)));
        fields.put("vnp_BankCode", "NCB"); fields.put("vnp_OrderInfo", "WebLens credits");
        fields.put("vnp_ResponseCode", "00"); fields.put("vnp_TmnCode", "TEST0001");
        fields.put("vnp_TransactionNo", transactionId(suffix)); fields.put("vnp_TransactionStatus", "00");
        fields.put("vnp_TxnRef", reference);
        var canonical = fields.entrySet().stream()
                .map(e -> e.getKey() + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(java.util.stream.Collectors.joining("&"));
        var mac = Mac.getInstance("HmacSHA512");
        mac.init(new SecretKeySpec(TEST_KEY.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
        fields.put("vnp_SecureHash", HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8))));
        Map<String, List<String>> query = new LinkedHashMap<>();
        fields.forEach((key, value) -> query.put(key, List.of(value)));
        return query;
    }
    private static UUID fundedOwner(String transactionId) {
        UUID owner = owner();
        var order = create(owner, "fund");
        payments.accept(order.profileId(), payment(order, Outcome.SUCCEEDED, transactionId));
        return owner;
    }
    private static UUID owner() {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into users(id,email,normalized_email,display_name,password_hash,status,created_at,updated_at)
                values (:id,:email,:email,'Billing test','test-only','ACTIVE',clock_timestamp(),clock_timestamp())
                """).param("id", id).param("email", id + "@example.test").update();
        return id;
    }
    private static UUID scan(UUID owner, int pages) {
        UUID website = UUID.randomUUID(), scan = UUID.randomUUID();
        jdbc.sql("""
                insert into websites(id,owner_id,display_name,canonical_url,hostname,status,created_at,updated_at)
                values (:id,:owner,'Test',:url,'example.test','ACTIVE',clock_timestamp(),clock_timestamp())
                """).param("id", website).param("owner", owner).param("url", "https://example.test/" + website).update();
        jdbc.sql("""
                insert into scans(id,website_id,requested_by_user_id,status,max_pages,max_depth,max_response_bytes,
                    max_duration_seconds,max_redirects,concurrency,collector_version,created_at,updated_at)
                values (:id,:website,:owner,'QUEUED',:pages,3,10485760,120,5,3,'test-v1',clock_timestamp(),clock_timestamp())
                """).param("id", scan).param("website", website).param("owner", owner).param("pages", pages).update();
        return scan;
    }
    private static void terminal(UUID scan, String status, long version) {
        jdbc.sql("update scans set status=:status,remote_execution_version=:version,finished_at=clock_timestamp() where id=:id")
                .param("status", status).param("version", version).param("id", scan).update();
    }
    private static long count(String table, UUID owner) {
        if (!List.of("payment_orders", "credit_ledger", "usage_reservations").contains(table)) throw new IllegalArgumentException();
        return jdbc.sql("select count(*) from " + table + " where owner_id=:owner").param("owner", owner).query(Long.class).single();
    }
    private static void reconciled(UUID owner) {
        var sum = jdbc.sql("select coalesce(sum(balance_delta),0)::bigint,coalesce(sum(held_delta),0)::bigint from credit_ledger where owner_id=:owner")
                .param("owner", owner).query((rs, row) -> List.of(rs.getLong(1), rs.getLong(2))).single();
        assertThat(repository.balance(owner).balanceCredits()).isEqualTo(sum.get(0));
        assertThat(repository.balance(owner).heldCredits()).isEqualTo(sum.get(1));
        assertThat(repository.balance(owner).availableCredits()).isNotNegative();
    }
    private static Properties config(String profileId, long credits) {
        return new Properties(profileId, Map.of(profileId, new Profile(Environment.SANDBOX, "TEST0001",
                TEST_KEY, URI.create("https://sandbox.vnpayment.vn/paymentv2/vpcpay.html"),
                URI.create("https://example.test/payment-return"))), Map.of("starter", new CreditPackage(10_000, "VND", credits)));
    }
    @SuppressWarnings("unchecked")
    private static <T> T proxy(T target) {
        var factory = new ProxyFactory(target);
        factory.addAdvice(new TransactionInterceptor(manager, new AnnotationTransactionAttributeSource()));
        return (T) factory.getProxy();
    }
    private static <T> List<T> parallel(int count, IntFunction<T> task) throws Exception {
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(32)) {
            var futures = java.util.stream.IntStream.range(0, count)
                    .mapToObj(i -> workers.submit(() -> { start.await(); return task.apply(i); })).toList();
            start.countDown();
            List<T> results = new ArrayList<>();
            for (var future : futures) results.add(future.get(30, TimeUnit.SECONDS));
            return results;
        }
    }
}
