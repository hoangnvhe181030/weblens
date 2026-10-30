package com.weblens.auth.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.time.Instant;
import java.time.Duration;
import java.net.ServerSocket;
import java.util.UUID;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.DockerClientFactory;

class RedisSessionStoreIT {
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4-alpine").withExposedPorts(6379);

    private static LettuceConnectionFactory connections;
    private static StringRedisTemplate redis;
    private static RedisSessionStore store;

    @BeforeAll
    static void connect() {
        String host = System.getProperty("weblens.test.redis.host");
        int port;
        if (host == null) {
            assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker or explicit test Redis required");
            REDIS.start();
            host = REDIS.getHost();
            port = REDIS.getMappedPort(6379);
        } else {
            port = Integer.parseInt(System.getProperty("weblens.test.redis.port"));
        }
        connections = new LettuceConnectionFactory(host, port);
        connections.afterPropertiesSet();
        redis = new StringRedisTemplate(connections);
        store = new RedisSessionStore(redis);
    }

    @AfterAll
    static void close() {
        if (connections != null) connections.destroy();
        if (REDIS.isRunning()) REDIS.stop();
    }

    @Test
    void unavailableRedisFailsClosedForEveryOperation() throws Exception {
        int unusedPort;
        try (var socket = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            unusedPort = socket.getLocalPort();
        }
        var config = new org.springframework.data.redis.connection.RedisStandaloneConfiguration("127.0.0.1", unusedPort);
        var client = org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration.builder()
                .commandTimeout(Duration.ofMillis(200)).shutdownTimeout(Duration.ZERO).build();
        var offline = new LettuceConnectionFactory(config, client);
        offline.afterPropertiesSet();
        try {
            var unavailable = new RedisSessionStore(new StringRedisTemplate(offline));
            UUID sid = UUID.randomUUID();
            UUID owner = UUID.randomUUID();
            Instant expiry = Instant.now().plusSeconds(60);
            java.util.List<org.assertj.core.api.ThrowableAssert.ThrowingCallable> operations = java.util.List.of(
                    () -> unavailable.create(sid, owner, "hash", expiry),
                    () -> unavailable.isActive(sid, owner),
                    () -> unavailable.matchesRefresh(sid, owner, "hash"),
                    () -> unavailable.rotate(sid, owner, "hash", "next", expiry),
                    () -> unavailable.revoke(sid, owner));
            for (var operation : operations) {
                assertThatThrownBy(operation).isInstanceOf(com.weblens.common.exception.ApiException.class)
                        .satisfies(error -> assertThat(((com.weblens.common.exception.ApiException) error).status())
                                .isEqualTo(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE));
            }
        } finally {
            offline.destroy();
        }
    }

    @Test
    void ownerExpiryAndRevocationAreEnforcedWithoutResurrectingSession() {
        UUID sid = UUID.randomUUID();
        UUID user = UUID.randomUUID();
        assertThat(store.isActive(sid, user)).isFalse();
        store.create(sid, user, "old-hash", Instant.now().plusSeconds(60));
        assertThat(store.isActive(sid, user)).isTrue();
        assertThat(store.isActive(sid, UUID.randomUUID())).isFalse();
        assertThat(redis.getExpire("weblens:auth:v1:session:" + sid)).isBetween(1L, 60L);
        assertThat(store.matchesRefresh(sid, user, "wrong")).isFalse();
        store.revoke(sid, UUID.randomUUID());
        assertThat(store.isActive(sid, user)).isTrue();
        assertThat(store.rotate(sid, user, "old-hash", "next-hash", Instant.now().plusSeconds(120))).isTrue();
        assertThat(store.matchesRefresh(sid, user, "old-hash")).isFalse();
        assertThat(store.matchesRefresh(sid, user, "next-hash")).isTrue();
        assertThat(store.rotate(sid, user, "old-hash", "replay", Instant.now().plusSeconds(120))).isFalse();
        store.revoke(sid, user);
        store.revoke(sid, user);
        assertThat(store.rotate(sid, user, "next-hash", "late", Instant.now().plusSeconds(120))).isFalse();
        assertThat(store.isActive(sid, user)).isFalse();

        UUID expired = UUID.randomUUID();
        store.create(expired, user, "expired", Instant.now().minusSeconds(1));
        assertThat(store.isActive(expired, user)).isFalse();
    }

    @Test
    void concurrentRotationHasOneWinnerAndLogoutAlwaysWinsPublicationRace() throws Exception {
        try (var executor = Executors.newFixedThreadPool(2)) {
            for (int i = 0; i < 20; i++) {
                UUID sid = UUID.randomUUID();
                UUID user = UUID.randomUUID();
                Instant expiry = Instant.now().plusSeconds(60);
                store.create(sid, user, "old", expiry);
                var first = executor.submit(() -> store.rotate(sid, user, "old", "one", expiry));
                var second = executor.submit(() -> store.rotate(sid, user, "old", "two", expiry));
                assertThat(first.get() ^ second.get()).isTrue();
                String winner = store.matchesRefresh(sid, user, "one") ? "one" : "two";
                var rotate = executor.submit(() -> store.rotate(sid, user, winner, "late", expiry));
                var logout = executor.submit(() -> store.revoke(sid, user));
                rotate.get();
                logout.get();
                assertThat(store.isActive(sid, user)).isFalse();
            }
        }
    }
}
