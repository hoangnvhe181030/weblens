package com.weblens.auth.repository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.auth.entity.AuthSessionEntity;
import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@DataJpaTest(showSql = false)
@ActiveProfiles("test")
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers(disabledWithoutDocker = true)
class IdentityPersistenceIT {

    private static final Instant NOW = Instant.parse("2026-09-10T10:00:00Z");

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    @Autowired
    private TestEntityManager em;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private AuthSessionRepository sessions;

    @ParameterizedTest
    @CsvSource({
        "normalized_email, ck_users_normalized_email_not_blank",
        "password_hash, ck_users_password_hash_not_blank"
    })
    void databaseRejectsEmptyIdentityMaterial(String column, String constraint) {
        UserEntity user = persistUser();
        // Column comes only from the fixed test cases, never from external input.
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET " + column + " = '' WHERE id = ?", user.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining(constraint);
    }

    @Test
    void normalizedEmailUniquenessIsEnforcedByDatabase() {
        UserEntity first = persistUser();
        UserEntity second = persistUser();
        assertThatThrownBy(() -> jdbc.update(
                "UPDATE users SET normalized_email = ? WHERE id = ?", first.getNormalizedEmail(), second.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("uq_users_normalized_email");
    }

    @Test
    void databaseRejectsUnnormalizedEmail() {
        UserEntity user = persistUser();
        assertThatThrownBy(() -> jdbc.update(
                "UPDATE users SET normalized_email = ? WHERE id = ?", "UPPER@example.com", user.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("ck_users_normalized_email");
    }

    @Test
    void sessionCannotReferenceMissingUser() {
        UserEntity user = persistUser();
        AuthSessionEntity session = persistSession(user.getId(), "a".repeat(64));
        assertThatThrownBy(() -> jdbc.update(
                "UPDATE auth_sessions SET user_id = ? WHERE id = ?", UUID.randomUUID(), session.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("fk_auth_sessions_user");
    }

    @ParameterizedTest
    @CsvSource({
        "refresh_jti_hash, ck_auth_sessions_refresh_hash",
        "csrf_token_hash, ck_auth_sessions_csrf_hash"
    })
    void sessionAcceptsOnlyHashShape(String column, String constraint) {
        AuthSessionEntity session = persistSession(persistUser().getId(), "a".repeat(64));
        assertThatThrownBy(() -> jdbc.update(
                "UPDATE auth_sessions SET " + column + " = ? WHERE id = ?", "not-a-hash", session.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining(constraint);
    }

    @Test
    void refreshIdentifierCannotBelongToTwoSessions() {
        UUID userId = persistUser().getId();
        persistSession(userId, "a".repeat(64));
        AuthSessionEntity second = persistSession(userId, "b".repeat(64));
        assertThatThrownBy(() -> jdbc.update(
                "UPDATE auth_sessions SET refresh_jti_hash = ? WHERE id = ?", "a".repeat(64), second.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("uq_auth_sessions_refresh_jti_hash");
    }

    @Test
    void sessionExpiryMustFollowCreation() {
        AuthSessionEntity session = persistSession(persistUser().getId(), "a".repeat(64));
        assertThatThrownBy(() -> jdbc.update(
                "UPDATE auth_sessions SET expires_at = created_at WHERE id = ?", session.getId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("ck_auth_sessions_expiry");
    }

    @Test
    void userDeletionDoesNotCascadeThroughSessions() {
        UUID userId = persistUser().getId();
        persistSession(userId, "a".repeat(64));
        assertThatThrownBy(() -> jdbc.update("DELETE FROM users WHERE id = ?", userId))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("fk_auth_sessions_user");
    }

    @Test
    void rotationAndRevocationSurviveDatabaseRoundTrip() {
        UUID sessionId = persistSession(persistUser().getId(), "a".repeat(64)).getId();
        AuthSessionEntity session = sessions.findByIdForUpdate(sessionId).orElseThrow();
        session.rotate("b".repeat(64), "c".repeat(64), NOW.plusSeconds(7200), NOW.plusSeconds(60));
        em.flush();
        em.clear();

        AuthSessionEntity rotated = sessions.findByIdForUpdate(sessionId).orElseThrow();
        assertThat(rotated.getRefreshJtiHash()).isEqualTo("b".repeat(64));
        assertThat(rotated.getCsrfTokenHash()).isEqualTo("c".repeat(64));
        assertThat(rotated.getRotatedAt()).isEqualTo(NOW.plusSeconds(60));
        assertThat(rotated.isUsableAt(NOW.plusSeconds(7200))).isFalse();
        rotated.revoke(NOW.plusSeconds(120));
        rotated.revoke(NOW.plusSeconds(180));
        em.flush();
        em.clear();

        AuthSessionEntity revoked = sessions.findByIdForUpdate(sessionId).orElseThrow();
        assertThat(revoked.getRevokedAt()).isEqualTo(NOW.plusSeconds(120));
        assertThat(revoked.isUsableAt(NOW.plusSeconds(121))).isFalse();
        assertThat(revoked.getVersion()).isEqualTo(2);
    }

    private UserEntity persistUser() {
        String email = UUID.randomUUID() + "@example.com";
        UserEntity user = new UserEntity(UUID.randomUUID(), email, email, "Test user",
                "{bcrypt}test-only-placeholder", UserStatus.ACTIVE, NOW, NOW);
        em.persist(user);
        em.flush();
        em.clear();
        return user;
    }

    private AuthSessionEntity persistSession(UUID userId, String refreshHash) {
        AuthSessionEntity session = new AuthSessionEntity(UUID.randomUUID(), userId, refreshHash,
                "d".repeat(64), NOW.plusSeconds(3600), NOW);
        em.persist(session);
        em.flush();
        em.clear();
        return session;
    }
}
