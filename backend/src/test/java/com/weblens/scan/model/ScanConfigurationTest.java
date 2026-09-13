package com.weblens.scan.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class ScanConfigurationTest {

    @Test
    void acceptsExperimentalStructuralCaps() {
        ScanConfiguration configuration = new ScanConfiguration(
                1_000_000, 10, 52_428_800, 604_800, 10, 10_000
        );

        assertThat(configuration.maxPages()).isEqualTo(1_000_000);
        assertThat(configuration.maxDurationSeconds()).isEqualTo(604_800);
        assertThat(configuration.concurrency()).isEqualTo(10_000);
    }

    @Test
    void rejectsValuesAboveExperimentalStructuralCaps() {
        assertThatThrownBy(() -> new ScanConfiguration(
                1_000_001, 10, 52_428_800, 604_800, 10, 10_000
        )).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ScanConfiguration(
                1_000_000, 10, 52_428_800, 604_801, 10, 10_000
        )).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ScanConfiguration(
                1_000_000, 10, 52_428_800, 604_800, 10, 10_001
        )).isInstanceOf(IllegalArgumentException.class);
    }
}
