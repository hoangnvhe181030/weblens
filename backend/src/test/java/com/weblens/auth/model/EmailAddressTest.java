package com.weblens.auth.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import org.junit.jupiter.api.Test;

class EmailAddressTest {

    @Test
    void normalizesCaseAndWhitespace() {
        assertThat(EmailAddress.of("  Developer@Example.COM ").value())
                .isEqualTo("developer@example.com");
    }

    @Test
    void rejectsBlankValues() {
        assertThatIllegalArgumentException().isThrownBy(() -> EmailAddress.of("  "));
    }
}
