package com.weblens.load;

import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.GetResponse;
import com.sun.net.httpserver.HttpServer;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Isolated transport experiment. The receiving inbox is simulated, not PostgreSQL. */
public final class DispatchEvaluation {
    private static final int WORK_MS = 20;
    private static final int PARALLELISM = 4;
    private static final int CONFIRM_TIMEOUT_MS = 5_000;

    private static final class Sink {
        private final Map<Integer, String> inbox = new ConcurrentHashMap<>();
        private final long[] accepted;
        private final long started = System.nanoTime();

        Sink(int count) { accepted = new long[count]; }

        void accept(byte[] body) throws InterruptedException {
            String text = new String(body, StandardCharsets.UTF_8);
            String[] parts = text.split(":", 2);
            if (parts.length != 2) throw new IllegalArgumentException("Invalid synthetic command");
            int id = Integer.parseInt(parts[0]);
            if (id < 0 || id >= accepted.length) throw new IllegalArgumentException("Invalid synthetic identity");
            Thread.sleep(WORK_MS);
            String previous = inbox.putIfAbsent(id, text);
            if (previous != null && !previous.equals(text)) throw new IllegalArgumentException("Message collision");
            if (previous == null) accepted[id] = System.nanoTime() - started;
        }

        String result(String mode, int round, long senderDone) {
            require(inbox.size() == accepted.length, "Missing accepted identities");
            require(Arrays.stream(accepted).allMatch(value -> value > 0), "Missing timing");
            long[] times = accepted.clone();
            Arrays.sort(times);
            double position = (times.length - 1) * 0.95;
            int left = (int) Math.floor(position);
            double p95 = times[left] + (times[(int) Math.ceil(position)] - times[left]) * (position - left);
            return String.format(Locale.ROOT,
                    "{\"mode\":\"%s\",\"round\":%d,\"commands\":%d,\"accepted\":%d,\"errors\":0,\"acceptanceP95Ms\":%.3f,\"allAcceptedMs\":%.3f,\"senderDoneMs\":%.3f}",
                    mode, round, accepted.length, inbox.size(), p95 / 1e6, times[times.length - 1] / 1e6, senderDone / 1e6);
        }
    }

    private static byte[] body(int id) {
        return (id + ":synthetic-command-v1").getBytes(StandardCharsets.UTF_8);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private static String http(int count, int parallelism, int round) throws Exception {
        Sink sink = new Sink(count);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        try (var receivers = Executors.newFixedThreadPool(PARALLELISM);
             var senders = Executors.newFixedThreadPool(parallelism)) {
            server.setExecutor(receivers);
            server.createContext("/commands", exchange -> {
                try {
                    byte[] payload = exchange.getRequestBody().readNBytes(128);
                    sink.accept(payload);
                    exchange.sendResponseHeaders(202, -1);
                } catch (Exception failure) {
                    exchange.sendResponseHeaders(422, -1);
                } finally { exchange.close(); }
            });
            server.start();
            URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/commands");
            List<java.util.concurrent.Future<?>> futures = new ArrayList<>();
            for (int id = 0; id < count; id++) {
                int message = id;
                futures.add(senders.submit(() -> {
                    HttpURLConnection request = null;
                    try {
                        request = (HttpURLConnection) endpoint.toURL().openConnection();
                        request.setRequestMethod("POST");
                        request.setDoOutput(true);
                        request.setConnectTimeout(5_000);
                        request.setReadTimeout(5_000);
                        request.setFixedLengthStreamingMode(body(message).length);
                        try (var output = request.getOutputStream()) { output.write(body(message)); }
                        require(request.getResponseCode() == 202, "HTTP acceptance failed");
                        try (var response = request.getInputStream()) { response.readAllBytes(); }
                    } catch (Exception failure) {
                        throw new IllegalStateException("Local HTTP command failed", failure);
                    } finally { if (request != null) request.disconnect(); }
                }));
            }
            for (var future : futures) future.get(45, TimeUnit.SECONDS);
            return sink.result("http-" + parallelism, round, System.nanoTime() - sink.started);
        } finally { server.stop(0); }
    }

    private static AMQP.BasicProperties properties(int id) {
        return new AMQP.BasicProperties.Builder().messageId(Integer.toString(id))
                .contentType("application/octet-stream").deliveryMode(2).build();
    }

    private static void topology(Channel channel, String queue, String dead) throws Exception {
        channel.queueDeclare(dead, true, false, false, Map.of("x-queue-type", "quorum"));
        channel.queueDeclare(queue, true, false, false, Map.of(
                "x-queue-type", "quorum", "x-delivery-limit", 5,
                "x-dead-letter-exchange", "", "x-dead-letter-routing-key", dead,
                "x-dead-letter-strategy", "at-least-once", "x-overflow", "reject-publish"));
    }

    private static String rabbit(Connection connection, int count, int round) throws Exception {
        String queue = "weblens.eval." + UUID.randomUUID();
        String dead = queue + ".dead";
        List<Channel> consumers = new ArrayList<>();
        try (Channel publisher = connection.createChannel()) {
            topology(publisher, queue, dead);
            publisher.confirmSelect();
            AtomicReference<Throwable> failure = new AtomicReference<>();
            publisher.addReturnListener(returned -> failure.set(new IllegalStateException("Unroutable command")));
            Sink sink = new Sink(count);
            CountDownLatch completed = new CountDownLatch(count);
            for (int worker = 0; worker < PARALLELISM; worker++) {
                Channel consumer = connection.createChannel();
                consumers.add(consumer);
                consumer.basicQos(1);
                consumer.basicConsume(queue, false, (tag, delivery) -> {
                    try {
                        sink.accept(delivery.getBody());
                        consumer.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
                    } catch (Exception error) {
                        failure.compareAndSet(null, error);
                        consumer.basicReject(delivery.getEnvelope().getDeliveryTag(), false);
                    } finally { completed.countDown(); }
                }, tag -> failure.compareAndSet(null, new IllegalStateException("Consumer cancelled")));
            }
            for (int id = 0; id < count; id++) {
                publisher.basicPublish("", queue, true, properties(id), body(id));
                if ((id + 1) % 25 == 0) publisher.waitForConfirmsOrDie(CONFIRM_TIMEOUT_MS);
            }
            publisher.waitForConfirmsOrDie(CONFIRM_TIMEOUT_MS);
            long confirmed = System.nanoTime() - sink.started;
            require(completed.await(45, TimeUnit.SECONDS), "Consumer acceptance deadline exceeded");
            require(failure.get() == null, "Broker or consumer error");
            require(publisher.queueDeclarePassive(dead).getMessageCount() == 0, "Unexpected dead letter");
            return sink.result("rabbit-4", round, confirmed);
        } finally {
            for (Channel consumer : consumers) if (consumer.isOpen()) consumer.close();
            try (Channel cleanup = connection.createChannel()) {
                cleanup.queueDelete(queue);
                cleanup.queueDelete(dead);
            }
        }
    }

    private static GetResponse get(Channel channel, String queue) throws Exception {
        for (int attempt = 0; attempt < 100; attempt++) {
            GetResponse response = channel.basicGet(queue, false);
            if (response != null) return response;
            Thread.sleep(20);
        }
        throw new IllegalStateException("Redelivery or dead-letter deadline exceeded");
    }

    private static void reliability(Connection connection) throws Exception {
        String queue = "weblens.eval.failure." + UUID.randomUUID();
        String dead = queue + ".dead";
        try (Channel publisher = connection.createChannel()) {
            topology(publisher, queue, dead);
            publisher.confirmSelect();
            AtomicReference<String> returnedId = new AtomicReference<>();
            publisher.addReturnListener(returned -> returnedId.set(returned.getProperties().getMessageId()));
            publisher.basicPublish("", queue + ".missing", true, properties(99), body(0));
            publisher.waitForConfirmsOrDie(CONFIRM_TIMEOUT_MS);
            require("99".equals(returnedId.get()), "Publisher confirm masked missing route");

            publisher.basicPublish("", queue, true, properties(0), body(0));
            publisher.waitForConfirmsOrDie(CONFIRM_TIMEOUT_MS);
            Sink sink = new Sink(1);
            try (Channel crashed = connection.createChannel()) {
                GetResponse delivery = get(crashed, queue);
                sink.accept(delivery.getBody());
                // Close after the simulated inbox commit, before acknowledgment.
            }
            try (Channel recovered = connection.createChannel()) {
                GetResponse delivery = get(recovered, queue);
                require(delivery.getEnvelope().isRedeliver(), "Unacknowledged command was not redelivered");
                sink.accept(delivery.getBody());
                recovered.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
                require(sink.inbox.size() == 1, "Duplicate execution in simulated inbox");

                publisher.basicPublish("", queue, true, properties(0), "0:conflicting-command".getBytes(StandardCharsets.UTF_8));
                publisher.waitForConfirmsOrDie(CONFIRM_TIMEOUT_MS);
                GetResponse conflict = get(recovered, queue);
                boolean rejected = false;
                try { sink.accept(conflict.getBody()); }
                catch (IllegalArgumentException expected) { rejected = true; }
                require(rejected, "Message collision was accepted");
                recovered.basicReject(conflict.getEnvelope().getDeliveryTag(), false);
                GetResponse deadLetter = get(recovered, dead);
                require(new String(deadLetter.getBody(), StandardCharsets.UTF_8).equals("0:conflicting-command"), "Incorrect dead letter");
                recovered.basicAck(deadLetter.getEnvelope().getDeliveryTag(), false);
            }
            System.out.println("RELIABILITY_PASS: mandatory-return, consumer-close-redelivery, simulated-inbox-dedup, collision-dead-letter");
        } finally {
            try (Channel cleanup = connection.createChannel()) {
                cleanup.queueDelete(queue);
                cleanup.queueDelete(dead);
            }
        }
    }

    private static void restartProbe(Connection connection, boolean prepare) throws Exception {
        // Fixed names are safe only inside the dedicated local evaluation broker.
        String queue = "weblens.eval.restart";
        String dead = queue + ".dead";
        try (Channel channel = connection.createChannel()) {
            if (prepare) {
                topology(channel, queue, dead);
                require(channel.queueDeclarePassive(queue).getMessageCount() == 0, "Restart queue is not empty");
                channel.confirmSelect();
                channel.basicPublish("", queue, true, properties(0), body(0));
                channel.waitForConfirmsOrDie(CONFIRM_TIMEOUT_MS);
                require(channel.queueDeclarePassive(queue).getMessageCount() == 1, "Restart message missing");
                System.out.println("RESTART_PREPARED: one confirmed persistent command in durable quorum queue");
            } else {
                GetResponse delivery = get(channel, queue);
                require(Arrays.equals(delivery.getBody(), body(0)), "Confirmed command did not survive restart");
                channel.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
                channel.queueDelete(queue);
                channel.queueDelete(dead);
                System.out.println("RESTART_PASS: confirmed persistent command survived actual broker restart");
            }
        }
    }

    public static void main(String[] arguments) throws Exception {
        require(arguments.length == 1, "Supply an output JSON path");
        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost("127.0.0.1");
        factory.setPort(5679);
        factory.setUsername("guest");
        factory.setPassword("guest"); // Dedicated loopback-only development broker.
        factory.setConnectionTimeout(5_000);
        factory.setAutomaticRecoveryEnabled(false);
        factory.setRequestedHeartbeat(10);
        List<String> results = new ArrayList<>();
        String brokerVersion;
        try (Connection connection = factory.newConnection("weblens-local-dispatch-evaluation")) {
            if (arguments[0].equals("--restart-prepare") || arguments[0].equals("--restart-verify")) {
                restartProbe(connection, arguments[0].equals("--restart-prepare"));
                return;
            }
            brokerVersion = String.valueOf(connection.getServerProperties().get("version"));
            reliability(connection);
            http(12, 1, 0);
            http(12, PARALLELISM, 0);
            rabbit(connection, 12, 0);
            for (int round = 1; round <= 3; round++) {
                for (int count : new int[]{150, 300, 500}) {
                    // Rotate order to reduce systematic warmup/order bias.
                    for (int offset = 0; offset < 3; offset++) {
                        int mode = (round + offset) % 3;
                        String result = switch (mode) {
                            case 0 -> http(count, 1, round);
                            case 1 -> http(count, PARALLELISM, round);
                            default -> rabbit(connection, count, round);
                        };
                        results.add(result);
                        System.out.println(result);
                    }
                }
            }
        }
        String report = "{\"type\":\"LOCAL_SYNTHETIC_TRANSPORT_ONLY\",\"createdAtUtc\":\"" + Instant.now()
                + "\",\"brokerVersion\":\"" + brokerVersion + "\",\"workMs\":" + WORK_MS
                + ",\"parallelism\":" + PARALLELISM
                + ",\"realPostgres\":false,\"realCrawler\":false,\"productionChanged\":false,\"reliabilityChecks\":4,\"results\":["
                + String.join(",", results) + "]}\n";
        Files.writeString(Path.of(arguments[0]), report, StandardCharsets.UTF_8);
        System.out.println("EVALUATION_COMPLETE: 27 samples; output saved; no production capacity conclusion");
    }
}
