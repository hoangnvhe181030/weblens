package com.weblens.auth.repository;

import com.weblens.auth.entity.AuthSessionEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface AuthSessionRepository extends JpaRepository<AuthSessionEntity, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select session from AuthSessionEntity session where session.id = :id")
    Optional<AuthSessionEntity> findByIdForUpdate(@Param("id") UUID id);
}
