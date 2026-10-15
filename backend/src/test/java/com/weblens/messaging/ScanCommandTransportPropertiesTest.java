package com.weblens.messaging;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class ScanCommandTransportPropertiesTest {
    @Test void rejectsMissingCredentialsAndPlaintextRemoteConnections() {
        assertThatThrownBy(() -> props("broker.example", "secret", false)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> props("127.0.0.1", "", false)).isInstanceOf(IllegalArgumentException.class);
        assertThat(props("broker.example", "secret", true).toString()).doesNotContain("secret");
        assertThat(props("127.0.0.1", "secret", false).transport()).isEqualTo(ScanCommandTransportProperties.Transport.RABBITMQ);
    }

    private static ScanCommandTransportProperties props(String host, String password, boolean tls) {
        return new ScanCommandTransportProperties(ScanCommandTransportProperties.Transport.RABBITMQ,
                host, 5672, "weblens", "user", password, tls);
    }
}
