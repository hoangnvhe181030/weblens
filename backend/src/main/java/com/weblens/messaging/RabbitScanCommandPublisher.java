package com.weblens.messaging;

import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.impl.nio.NioParams;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLContext;

/** One connection/channel per bounded dispatcher thread; no shared channel publication. */
final class RabbitScanCommandPublisher implements AutoCloseable {
    static final String EXCHANGE = "weblens.scan.commands";
    static final String ROUTING_KEY = "scan";
    // Includes connection/channel setup and bounded enqueue of the command frames.
    static final Duration SETUP_BUDGET = Duration.ofSeconds(12);
    static final Duration CONFIRM_BUDGET = Duration.ofSeconds(5);
    private final ConnectionFactory factory;
    private final String username;
    private final ThreadLocal<Session> local = new ThreadLocal<>();
    private final Set<Connection> connections = ConcurrentHashMap.newKeySet();

    RabbitScanCommandPublisher(ScanCommandTransportProperties properties) {
        factory = new ConnectionFactory();
        factory.setHost(properties.host());
        factory.setPort(properties.port());
        factory.setVirtualHost(properties.virtualHost());
        username = properties.username();
        factory.setUsername(username);
        factory.setPassword(properties.password());
        factory.setAutomaticRecoveryEnabled(false); // Durable outbox owns retry and reconnect.
        factory.setConnectionTimeout(2_000);
        factory.setHandshakeTimeout(2_000);
        factory.setChannelRpcTimeout(2_000);
        factory.setRequestedHeartbeat(5);
        factory.setNioParams(new NioParams().setWriteEnqueuingTimeoutInMs(500));
        factory.useNio();
        if (properties.tls()) {
            try {
                factory.useSslProtocol(SSLContext.getDefault());
                factory.enableHostnameVerification();
            } catch (Exception exception) {
                throw new IllegalStateException("RabbitMQ TLS initialization failed", exception);
            }
        }
    }

    void publish(OutboxRecord message) {
        byte[] body = message.payload().getBytes(StandardCharsets.UTF_8);
        if (body.length == 0 || body.length > 65_536) throw new IllegalArgumentException("Command exceeds 64 KiB");
        Session session = local.get();
        try {
            if (session == null || !session.connection().isOpen() || !session.channel().isOpen()) {
                discard(session);
                Connection connection = factory.newConnection("weblens-control-scan-dispatch");
                connections.add(connection);
                try {
                    Channel channel = connection.createChannel();
                    channel.confirmSelect();
                    AtomicBoolean returned = new AtomicBoolean();
                    channel.addReturnListener(result -> returned.set(true));
                    session = new Session(connection, channel, returned);
                    local.set(session);
                } catch (Exception exception) {
                    connection.abort(0);
                    connections.remove(connection);
                    throw exception;
                }
            }
            session.returned().set(false);
            session.channel().basicPublish(EXCHANGE, ROUTING_KEY, true,
                    new AMQP.BasicProperties.Builder().contentType("application/json").contentEncoding("UTF-8")
                            .deliveryMode(2).messageId(message.messageId().toString())
                            .correlationId(message.correlationId().toString()).userId(username).build(), body);
            session.channel().waitForConfirmsOrDie(CONFIRM_BUDGET.toMillis());
            if (session.returned().get()) throw new IllegalStateException("RabbitMQ command was not routed");
        } catch (Exception exception) {
            discard(session);
            if (exception instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new IllegalStateException("RabbitMQ scan command was not confirmed", exception);
        }
    }

    private void discard(Session session) {
        local.remove();
        if (session != null) {
            session.connection().abort(0);
            connections.remove(session.connection());
        }
    }

    @Override public void close() {
        connections.forEach(connection -> connection.abort(0));
        connections.clear();
    }

    private record Session(Connection connection, Channel channel, AtomicBoolean returned) {}
}
