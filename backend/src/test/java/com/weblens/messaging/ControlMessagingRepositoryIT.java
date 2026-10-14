package com.weblens.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@Testcontainers
class ControlMessagingRepositoryIT {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");
    static JdbcClient jdbc;
    static ControlMessagingRepository messages;
    static DriverManagerDataSource source;

    @BeforeAll
    static void database() {
        source = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(source)
                .configuration(java.util.Map.of("flyway.postgresql.transactional.lock", "false"))
                .load().migrate();
        jdbc = JdbcClient.create(source);
        var proxy = new ProxyFactory(new ControlMessagingRepository(jdbc, new ObjectMapper().findAndRegisterModules()));
        proxy.addAdvice(new TransactionInterceptor(new JdbcTransactionManager(source), new AnnotationTransactionAttributeSource()));
        messages = (ControlMessagingRepository) proxy.getProxy();
    }

    @BeforeEach
    void clean() { jdbc.sql("delete from outbox_events").update(); }

    @Test
    void concurrentClaimsAreDisjointAndExpiredSameOwnerAttemptCannotAcknowledge() throws Exception {
        for (int index = 0; index < 20; index++) enqueue("SCAN", "SCAN_REQUESTED");
        var start = new CountDownLatch(1);
        List<OutboxRecord> first, second;
        try (var workers = Executors.newFixedThreadPool(2)) {
            var one = workers.submit(() -> { start.await(); return messages.claim(UUID.randomUUID(), 10, Duration.ofSeconds(30), Instant.now()); });
            var two = workers.submit(() -> { start.await(); return messages.claim(UUID.randomUUID(), 10, Duration.ofSeconds(30), Instant.now()); });
            start.countDown();
            first = one.get(5, TimeUnit.SECONDS);
            second = two.get(5, TimeUnit.SECONDS);
        }
        assertThat(first).hasSize(10);
        assertThat(second).hasSize(10);
        assertThat(first.stream().map(OutboxRecord::messageId).toList())
                .doesNotContainAnyElementsOf(second.stream().map(OutboxRecord::messageId).toList());
        OutboxRecord old = first.getFirst();
        expire(old);
        assertThat(messages.complete(old, Instant.now())).isFalse();
        assertThat(messages.retry(old, "DELIVERY_FAILED", Instant.now())).isFalse();
        OutboxRecord reclaimed = messages.claim(old.leaseOwner(), 1, Duration.ofSeconds(30), Instant.now()).getFirst();
        assertThat(reclaimed.messageId()).isEqualTo(old.messageId());
        assertThat(reclaimed.deliveryAttempts()).isEqualTo(old.deliveryAttempts() + 1);
        assertThat(messages.complete(old, Instant.now())).isFalse();
        assertThat(messages.retry(old, "DELIVERY_FAILED", Instant.now())).isFalse();
        assertThat(messages.complete(reclaimed, Instant.now())).isTrue();
        assertThat(messages.complete(reclaimed, Instant.now())).isFalse();
    }

    @Test
    void deadRetryUsesCooldownAndSameMessageIdentityAcrossRestart() {
        UUID id = enqueue("SCAN", "SCAN_REQUESTED");
        jdbc.sql("update outbox_events set delivery_attempts=19 where message_id=:id").param("id", id).update();
        OutboxRecord claimed = messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()).getFirst();
        assertThat(messages.retry(claimed, "CRAWLER_UNAVAILABLE", Instant.now())).isTrue();
        assertThat(jdbc.sql("select status from outbox_events where message_id=:id").param("id", id).query(String.class).single())
                .isEqualTo("DEAD");
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now())).isEmpty();
        jdbc.sql("update outbox_events set available_at=clock_timestamp() where message_id=:id").param("id", id).update();
        var restarted = new ControlMessagingRepository(jdbc, new ObjectMapper());
        OutboxRecord retry = restarted.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()).getFirst();
        assertThat(retry.messageId()).isEqualTo(id);
        assertThat(restarted.complete(retry, Instant.now())).isTrue();
    }

    @Test
    void captureAndSiteCloneClaimsUseTheirOwnScopes() {
        UUID scan = enqueue("SCAN", "SCAN_REQUESTED");
        UUID capture = enqueue("CAPTURE", "CAPTURE_REQUESTED");
        UUID site = enqueue("SITE_CLONE", "SITE_CLONE_REQUESTED");
        assertThat(messages.claimCaptures(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()))
                .extracting(OutboxRecord::messageId).containsExactly(capture);
        assertThat(messages.claimSiteClones(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()))
                .extracting(OutboxRecord::messageId).containsExactly(site);
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()))
                .extracting(OutboxRecord::messageId).containsExactly(scan);
    }

    @Test
    void cancellationWaitsForCreateAcknowledgementWhileOtherAggregatesProgress() {
        UUID create = enqueue("SCAN", "SCAN_REQUESTED");
        UUID cancel = enqueue("SCAN", "SCAN_CANCEL_REQUESTED");
        jdbc.sql("""
                update outbox_events set aggregate_id=(select aggregate_id from outbox_events where message_id=:create),
                  aggregate_version=2 where message_id=:cancel
                """).param("create", create).param("cancel", cancel).update();
        OutboxRecord active = messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()).getFirst();
        assertThat(active.messageId()).isEqualTo(create);
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now())).isEmpty();
        UUID unrelated = enqueue("SCAN", "SCAN_REQUESTED");
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()))
                .extracting(OutboxRecord::messageId).containsExactly(unrelated);
        assertThat(messages.complete(active, Instant.now())).isTrue();
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()))
                .extracting(OutboxRecord::messageId).containsExactly(cancel);
    }

    @Test
    void acknowledgementRechecksExpiryAfterWaitingForARowLock() throws Exception {
        UUID id = enqueue("SCAN", "SCAN_REQUESTED");
        OutboxRecord claimed = messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()).getFirst();
        jdbc.sql("update outbox_events set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where message_id=:id")
                .param("id", id).update();
        try (var connection = source.getConnection(); var workers = Executors.newSingleThreadExecutor()) {
            connection.setAutoCommit(false);
            try (var lock = connection.prepareStatement("select message_id from outbox_events where message_id=? for update")) {
                lock.setObject(1, id);
                lock.executeQuery().close();
            }
            var acknowledgement = workers.submit(() -> messages.complete(claimed, Instant.now()));
            try {
                boolean waiting = false;
                for (int index = 0; index < 50; index++) {
                    waiting = jdbc.sql("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%outbox_events%')")
                            .query(Boolean.class).single();
                    if (waiting) break;
                    Thread.sleep(10);
                }
                assertThat(waiting).isTrue();
                Thread.sleep(600);
            } finally { connection.rollback(); }
            assertThat(acknowledgement.get(3, TimeUnit.SECONDS)).isFalse();
        }
    }

    @Test
    void blockedAcknowledgementHasABoundedDatabaseBudget() throws Exception {
        UUID id = enqueue("SCAN", "SCAN_REQUESTED");
        OutboxRecord claimed = messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.now()).getFirst();
        try (var connection = source.getConnection(); var workers = Executors.newSingleThreadExecutor()) {
            connection.setAutoCommit(false);
            try (var lock = connection.prepareStatement("select message_id from outbox_events where message_id=? for update")) {
                lock.setObject(1, id);
                lock.executeQuery().close();
            }
            try {
                var acknowledgement = workers.submit(() -> messages.complete(claimed, Instant.now()));
                assertThatThrownBy(() -> acknowledgement.get(8, TimeUnit.SECONDS))
                        .isInstanceOf(java.util.concurrent.ExecutionException.class)
                        .hasCauseInstanceOf(org.springframework.dao.DataAccessException.class);
            } finally { connection.rollback(); }
        }
        assertThat(jdbc.sql("select status from outbox_events where message_id=:id").param("id", id)
                .query(String.class).single()).isEqualTo("CLAIMED");
        assertThat(messages.complete(claimed, Instant.now())).isTrue();
    }

    @Test
    void leaseAndRetryEligibilityUseDatabaseTimeDespiteJvmClockSkew() {
        UUID id = UUID.randomUUID();
        messages.enqueue(new com.weblens.messaging.contract.MessageEnvelope<>(id, "SCAN", UUID.randomUUID(),
                1, "SCAN_REQUESTED", 1, UUID.randomUUID(), Instant.parse("2099-01-01T00:00:00Z"),
                java.util.Map.of("scanId", UUID.randomUUID())));
        OutboxRecord record = messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.EPOCH).getFirst();
        assertThat(record.messageId()).isEqualTo(id);
        assertThat(jdbc.sql("select lease_expires_at between clock_timestamp()+interval '25 seconds' and clock_timestamp()+interval '31 seconds' from outbox_events where message_id=:id")
                .param("id", id).query(Boolean.class).single()).isTrue();
        Instant futureJvm = Instant.parse("2099-01-01T00:00:00Z");
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), futureJvm)).isEmpty();
        assertThat(messages.retry(record, "DELIVERY_FAILED", futureJvm)).isTrue();
        assertThat(jdbc.sql("select available_at between clock_timestamp()-interval '1 second' and clock_timestamp()+interval '2 seconds' from outbox_events where message_id=:id")
                .param("id", id).query(Boolean.class).single()).isTrue();
        jdbc.sql("update outbox_events set available_at=clock_timestamp()-interval '1 second' where message_id=:id")
                .param("id", id).update();
        assertThat(messages.claim(UUID.randomUUID(), 1, Duration.ofSeconds(30), Instant.EPOCH))
                .extracting(OutboxRecord::messageId).containsExactly(id);
    }

    private static void expire(OutboxRecord record) {
        jdbc.sql("update outbox_events set lease_expires_at=clock_timestamp()-interval '1 second' where message_id=:id")
                .param("id", record.messageId()).update();
    }

    private static UUID enqueue(String aggregate, String event) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into outbox_events(message_id,aggregate_type,aggregate_id,aggregate_version,event_type,
                  contract_version,correlation_id,payload,status,available_at,created_at)
                values(:id,:aggregate,:aggregateId,1,:event,1,:correlation,'{}'::jsonb,'PENDING',clock_timestamp(),clock_timestamp())
                """)
                .param("id", id).param("aggregate", aggregate).param("aggregateId", UUID.randomUUID())
                .param("event", event).param("correlation", UUID.randomUUID()).update();
        return id;
    }
}
