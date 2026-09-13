package com.weblens.messaging.contract;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ScanProgressPayloadValidationTest {

    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    @Test
    void acceptsCountersAtTheExperimentalHardCap() {
        ScanProgressPayload payload = payload(1_000_000);

        assertThat(validator.validate(payload)).isEmpty();
    }

    @Test
    void rejectsCountersAboveTheExperimentalHardCap() {
        ScanProgressPayload payload = payload(1_000_001);

        assertThat(validator.validate(payload))
                .extracting(violation -> violation.getPropertyPath().toString())
                .contains("discoveredCount");
    }

    private ScanProgressPayload payload(int discoveredCount) {
        return new ScanProgressPayload(
                UUID.randomUUID(), UUID.randomUUID(), "RUNNING",
                discoveredCount, 0, 0, 0, 0,
                0, 0, null, null
        );
    }
}
