package com.weblens.scan.entity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanNotCancellableException;
import com.weblens.scan.model.ScanStatus;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ScanEntityTest {

    private static final ScanConfiguration CONFIG = new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3);
    private static final Instant CREATED = Instant.parse("2026-09-09T10:00:00Z");

    @Test
    void queuedCancellationTerminatesImmediatelyAndIsIdempotent() {
        ScanEntity scan = scan();

        assertThat(scan.requestCancellation(CREATED.plusSeconds(1))).isTrue();
        assertThat(scan.getStatus()).isEqualTo(ScanStatus.CANCELLED);
        assertThat(scan.getFinishedAt()).isEqualTo(CREATED.plusSeconds(1));
		assertThat(scan.getCancellationRequestedAt()).isEqualTo(CREATED.plusSeconds(1));
        assertThat(scan.requestCancellation(CREATED.plusSeconds(2))).isFalse();
    }

    @Test
    void completedScanCannotBeCancelled() {
        ScanEntity scan = scan();
        scan.transitionTo(ScanStatus.RUNNING, CREATED.plusSeconds(1));
        scan.transitionTo(ScanStatus.COMPLETED, CREATED.plusSeconds(2));

        assertThatThrownBy(() -> scan.requestCancellation(CREATED.plusSeconds(3)))
                .isInstanceOf(ScanNotCancellableException.class);
    }

    private ScanEntity scan() {
        return new ScanEntity(
                UUID.randomUUID(),
                UUID.randomUUID(),
                UUID.randomUUID(),
                CONFIG,
                "crawler-v1",
                null,
                null,
                CREATED
        );
    }
}
