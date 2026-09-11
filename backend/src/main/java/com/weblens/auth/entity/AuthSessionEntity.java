package com.weblens.auth.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "auth_sessions")
public class AuthSessionEntity {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "refresh_jti_hash", nullable = false, length = 64, unique = true)
    private String refreshJtiHash;

    @Column(name = "csrf_token_hash", nullable = false, length = 64)
    private String csrfTokenHash;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "rotated_at")
    private Instant rotatedAt;

    @Version
    @Column(nullable = false)
    private long version;

    protected AuthSessionEntity() {
    }

    public AuthSessionEntity(
            UUID id,
            UUID userId,
            String refreshJtiHash,
            String csrfTokenHash,
            Instant expiresAt,
            Instant createdAt
    ) {
        this.id = id;
        this.userId = userId;
        this.refreshJtiHash = refreshJtiHash;
        this.csrfTokenHash = csrfTokenHash;
        this.expiresAt = expiresAt;
        this.createdAt = createdAt;
    }

    public void rotate(String newRefreshJtiHash, String newCsrfTokenHash, Instant newExpiresAt, Instant now) {
        this.refreshJtiHash = newRefreshJtiHash;
        this.csrfTokenHash = newCsrfTokenHash;
        this.expiresAt = newExpiresAt;
        this.rotatedAt = now;
    }

    public void revoke(Instant now) {
        if (revokedAt == null) {
            revokedAt = now;
        }
    }

    public boolean isUsableAt(Instant now) {
        return revokedAt == null && expiresAt.isAfter(now);
    }

    public UUID getId() {
        return id;
    }

    public UUID getUserId() {
        return userId;
    }

    public String getRefreshJtiHash() {
        return refreshJtiHash;
    }

    public String getCsrfTokenHash() {
        return csrfTokenHash;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public Instant getRevokedAt() {
        return revokedAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getRotatedAt() {
        return rotatedAt;
    }

    public long getVersion() {
        return version;
    }
}
