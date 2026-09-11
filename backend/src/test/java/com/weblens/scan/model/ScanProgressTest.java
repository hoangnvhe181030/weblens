package com.weblens.scan.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import org.junit.jupiter.api.Test;

class ScanProgressTest {

    @Test
    void acceptsConsistentProgress() {
        ScanProgress progress = new ScanProgress(8, 2, 6, 5, 1, 25);

        assertThat(progress.processed()).isEqualTo(6);
    }

    @Test
    void rejectsCountsBeyondLimitAndInconsistentProcessedTotal() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new ScanProgress(26, 0, 0, 0, 0, 25));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new ScanProgress(8, 2, 6, 4, 1, 25));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new ScanProgress(3, 0, 4, 4, 0, 25));
    }
}
