package com.weblens.capture.repository;

import com.weblens.capture.entity.CaptureRequestEntity;
import java.util.Optional;
import java.util.Collection;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CaptureRequestRepository extends JpaRepository<CaptureRequestEntity, UUID> {

    Optional<CaptureRequestEntity> findByIdAndOwnerId(UUID id, UUID ownerId);

    Optional<CaptureRequestEntity> findByOwnerIdAndIdempotencyKeyHash(UUID ownerId, String idempotencyKeyHash);

    boolean existsByOwnerIdAndScanIdAndPageIdAndStatusIn(
            UUID ownerId,
            UUID scanId,
            UUID pageId,
            Collection<com.weblens.capture.model.CaptureStatus> statuses
    );

    Optional<CaptureRequestEntity> findFirstByOwnerIdAndScanIdAndPageIdAndStatusInOrderByCreatedAtDescIdDesc(
            UUID ownerId,
            UUID scanId,
            UUID pageId,
            Collection<com.weblens.capture.model.CaptureStatus> statuses
    );

    @Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @Query("select capture from CaptureRequestEntity capture where capture.id = :id and capture.ownerId = :ownerId")
    Optional<CaptureRequestEntity> findOwnedForUpdate(@Param("id") UUID id, @Param("ownerId") UUID ownerId);
}
