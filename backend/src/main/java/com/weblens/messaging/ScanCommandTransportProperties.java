package com.weblens.messaging;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("weblens.scan-commands")
public record ScanCommandTransportProperties(
        @DefaultValue("HTTP") Transport transport,
        @DefaultValue("127.0.0.1") String host,
        @DefaultValue("5672") int port,
        @DefaultValue("weblens") String virtualHost,
        @DefaultValue("weblens_control") String username,
        @DefaultValue("") String password,
        @DefaultValue("false") boolean tls
) {
    public enum Transport { HTTP, RABBITMQ }

    public ScanCommandTransportProperties {
        if (transport == Transport.RABBITMQ) {
            if (host == null || host.isBlank() || port < 1 || port > 65535
                    || virtualHost == null || virtualHost.isBlank()
                    || username == null || username.isBlank() || password == null || password.isBlank()) {
                throw new IllegalArgumentException("RabbitMQ requires host, port, vhost and credentials");
            }
            if (!tls && !host.equals("127.0.0.1") && !host.equals("::1") && !host.equals("localhost")) {
                throw new IllegalArgumentException("RabbitMQ requires TLS outside loopback");
            }
        }
    }

    @Override public String toString() { return "ScanCommandTransportProperties[transport=" + transport + ", credentials=redacted]"; }
}
