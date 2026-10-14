package com.weblens.auth.security;

import com.weblens.common.exception.ApiException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/** Positive registry: a missing session never grants access or gets reconstructed. */
@Component
public class RedisSessionStore {
    private static final String PREFIX = "weblens:auth:v1:session:";
    private static final DefaultRedisScript<Long> CREATE = new DefaultRedisScript<>("""
            if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PXAT', ARGV[2]) then return 1 end
            return 0
            """, Long.class);
    private static final DefaultRedisScript<Long> ROTATE = new DefaultRedisScript<>("""
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
            redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> REVOKE = new DefaultRedisScript<>("""
            local current = redis.call('GET', KEYS[1])
            if current and string.sub(current, 1, string.len(ARGV[1])) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    public RedisSessionStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public void create(UUID sessionId, UUID userId, String refreshHash, Instant expiresAt) {
        Long created = execute(() -> redis.execute(CREATE, List.of(key(sessionId)),
                value(userId, refreshHash), Long.toString(expiresAt.toEpochMilli())));
        if (!Long.valueOf(1).equals(created)) {
            throw unavailable(null);
        }
    }

    public boolean isActive(UUID sessionId, UUID userId) {
        String value = execute(() -> redis.opsForValue().get(key(sessionId)));
        return value != null && value.startsWith(userId + ":");
    }

    public boolean matchesRefresh(UUID sessionId, UUID userId, String refreshHash) {
        return value(userId, refreshHash).equals(execute(() -> redis.opsForValue().get(key(sessionId))));
    }

    public boolean rotate(UUID sessionId, UUID userId, String oldHash, String nextHash, Instant expiresAt) {
        return Long.valueOf(1).equals(execute(() -> redis.execute(ROTATE, List.of(key(sessionId)),
                value(userId, oldHash), value(userId, nextHash), Long.toString(expiresAt.toEpochMilli()))));
    }

    public void revoke(UUID sessionId, UUID userId) {
        execute(() -> redis.execute(REVOKE, List.of(key(sessionId)), userId + ":"));
    }

    private <T> T execute(Supplier<T> operation) {
        try {
            return operation.get();
        } catch (DataAccessException exception) {
            throw unavailable(exception);
        }
    }

    private static ApiException unavailable(Throwable cause) {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "AUTH_SESSION_STORE_UNAVAILABLE",
                "Authentication temporarily unavailable", "The authentication session store is unavailable.", cause);
    }

    private static String key(UUID sessionId) {
        return PREFIX + sessionId;
    }

    private static String value(UUID userId, String refreshHash) {
        return userId + ":" + refreshHash;
    }
}
