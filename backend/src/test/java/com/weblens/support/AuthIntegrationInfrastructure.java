package com.weblens.support;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;

/** Shared real infrastructure; explicit local endpoints must point to disposable test data. */
public abstract class AuthIntegrationInfrastructure {
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");
    private static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7.4-alpine").withExposedPorts(6379);

    public static boolean available() {
        return System.getProperty("weblens.test.postgres.url") != null
                || DockerClientFactory.instance().isDockerAvailable();
    }

    @DynamicPropertySource
    static void infrastructure(DynamicPropertyRegistry registry) {
        String url = System.getProperty("weblens.test.postgres.url");
        if (url != null) {
            if (!url.matches("jdbc:postgresql://127\\.0\\.0\\.1:[0-9]+/weblens_test_[a-z0-9_]+")) {
                throw new IllegalArgumentException("Explicit auth test database must be local and named weblens_test_*");
            }
            registry.add("spring.datasource.url", () -> url);
            registry.add("spring.datasource.username", () -> System.getProperty("weblens.test.postgres.user", "postgres"));
            registry.add("spring.datasource.password", () -> System.getProperty("weblens.test.postgres.password", ""));
            registry.add("spring.data.redis.host", () -> System.getProperty("weblens.test.redis.host", "127.0.0.1"));
            registry.add("spring.data.redis.port", () -> Integer.parseInt(System.getProperty("weblens.test.redis.port")));
        } else {
            assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker or explicit test endpoints required");
            if (!POSTGRES.isRunning()) POSTGRES.start();
            if (!REDIS.isRunning()) REDIS.start();
            registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
            registry.add("spring.datasource.username", POSTGRES::getUsername);
            registry.add("spring.datasource.password", POSTGRES::getPassword);
            registry.add("spring.data.redis.host", REDIS::getHost);
            registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
        }
        registry.add("spring.data.redis.username", () -> "");
        registry.add("spring.data.redis.password", () -> "");
        registry.add("spring.data.redis.ssl.enabled", () -> false);
    }
}
