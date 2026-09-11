package com.weblens.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.entity.WebsiteEntity;
import com.weblens.website.model.WebsiteStatus;
import com.weblens.website.repository.WebsiteRepository;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@DataJpaTest
@ActiveProfiles("test")
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers(disabledWithoutDocker = true)
class FoundationPersistenceIT {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private WebsiteRepository websites;

    @Autowired
    private ScanRepository scans;

    @Test
    void flywaySchemaSupportsArchiveThenRegisterSameCanonicalUrl() {
        Instant now = Instant.parse("2026-09-09T10:00:00Z");
        UserEntity owner = owner(now);
        WebsiteEntity archived = website(owner.getId(), "First", now);
        entityManager.persist(owner);
        entityManager.persist(archived);
        entityManager.flush();

        archived.archive(now.plusSeconds(1));
        entityManager.flush();
        entityManager.clear();

        WebsiteEntity replacement = website(owner.getId(), "Replacement", now.plusSeconds(2));
        entityManager.persist(replacement);
        entityManager.flush();
        entityManager.clear();

        assertThat(websites.existsByOwnerIdAndCanonicalUrlAndStatus(
                owner.getId(),
                "https://example.com/",
                WebsiteStatus.ACTIVE
        )).isTrue();
        assertThat(websites.count()).isEqualTo(2);
    }

    @Test
    void repositoryQueriesRemainOwnerScopedAndDeterministicallyOrdered() {
        Instant now = Instant.parse("2026-09-09T10:00:00Z");
        UserEntity owner = owner(now);
        WebsiteEntity website = website(owner.getId(), "Target", now);
        entityManager.persist(owner);
        entityManager.persist(website);
        entityManager.persist(completedScan(owner.getId(), website.getId(), now));
        entityManager.persist(completedScan(owner.getId(), website.getId(), now.plusSeconds(1)));
        entityManager.flush();
        entityManager.clear();

        var page = scans.findAllByWebsiteIdAndRequestedByUserId(
                website.getId(),
                owner.getId(),
                PageRequest.of(0, 20, Sort.by(Sort.Direction.DESC, "createdAt"))
        );

        assertThat(page.getTotalElements()).isEqualTo(2);
        assertThat(page.getContent()).extracting(ScanEntity::getCreatedAt)
                .containsExactly(now.plusSeconds(1), now);
        assertThat(scans.findAllByWebsiteIdAndRequestedByUserId(
                website.getId(),
                UUID.randomUUID(),
                PageRequest.of(0, 20)
        )).isEmpty();
    }

    private UserEntity owner(Instant now) {
        return new UserEntity(
                UUID.randomUUID(),
                "developer@example.com",
                "developer@example.com",
                "Developer",
                "{bcrypt}test-only-not-a-real-hash",
                UserStatus.ACTIVE,
                now,
                now
        );
    }

    private WebsiteEntity website(UUID ownerId, String name, Instant now) {
        return new WebsiteEntity(
                UUID.randomUUID(),
                ownerId,
                name,
                "https://example.com/",
                "example.com",
                now
        );
    }

    private ScanEntity scan(UUID ownerId, UUID websiteId, Instant now) {
        return new ScanEntity(
                UUID.randomUUID(),
                websiteId,
                ownerId,
                new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3),
                "crawler-v1",
                null,
                null,
                now
        );
    }

    private ScanEntity completedScan(UUID ownerId, UUID websiteId, Instant createdAt) {
        ScanEntity scan = scan(ownerId, websiteId, createdAt);
        scan.requestCancellation(createdAt.plusMillis(1));
        return scan;
    }
}
