package com.weblens.website.entity;

import com.weblens.website.model.WebsiteStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "websites")
public class WebsiteEntity {

    @Id
    private UUID id;

    @Column(name = "owner_id", nullable = false)
    private UUID ownerId;

    @Column(name = "display_name", nullable = false, length = 120)
    private String displayName;

    @Column(name = "canonical_url", nullable = false, length = 2048)
    private String canonicalUrl;

    @Column(nullable = false, length = 253)
    private String hostname;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private WebsiteStatus status;

    @Column(name = "archived_at")
    private Instant archivedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    @Column(nullable = false)
    private long version;

    protected WebsiteEntity() {
    }

    public WebsiteEntity(
            UUID id,
            UUID ownerId,
            String displayName,
            String canonicalUrl,
            String hostname,
            Instant now
    ) {
        this.id = id;
        this.ownerId = ownerId;
        this.displayName = displayName;
        this.canonicalUrl = canonicalUrl;
        this.hostname = hostname;
        this.status = WebsiteStatus.ACTIVE;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public void rename(String name, Instant now) {
        this.displayName = name;
        this.updatedAt = now;
    }

    public void archive(Instant now) {
        this.status = WebsiteStatus.ARCHIVED;
        this.archivedAt = now;
        this.updatedAt = now;
    }

    public UUID getId() {
        return id;
    }

    public UUID getOwnerId() {
        return ownerId;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getCanonicalUrl() {
        return canonicalUrl;
    }

    public String getHostname() {
        return hostname;
    }

    public WebsiteStatus getStatus() {
        return status;
    }

    public Instant getArchivedAt() {
        return archivedAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public long getVersion() {
        return version;
    }
}
