package com.weblens.messaging;

import java.time.Duration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Claims run inside available sender slots; no claimed messages wait in a local queue. */
final class CommandDispatchExecutor implements AutoCloseable {

    static final int DATABASE_TIMEOUT_SECONDS = 5;

    private static final Logger LOGGER = LoggerFactory.getLogger(CommandDispatchExecutor.class);
    private final ExecutorService executor;
    private final Semaphore slots;
    private final int concurrency;

    CommandDispatchExecutor(String name, int concurrency) {
        if (concurrency < 1 || concurrency > 16) {
            throw new IllegalArgumentException("Dispatch concurrency must be between 1 and 16");
        }
        this.concurrency = concurrency;
        slots = new Semaphore(concurrency);
        executor = Executors.newFixedThreadPool(concurrency,
                Thread.ofPlatform().name(name + "-", 0).factory());
    }

    void poll(BooleanSupplier claimAndSend) {
        for (int index = 0; index < concurrency && !executor.isShutdown(); index++) {
            if (!slots.tryAcquire()) return;
            try {
                executor.execute(() -> {
                    try {
                        // Each send has its own fresh claim; cap each drain so polling remains fair.
                        for (int sent = 0; sent < 25 && !executor.isShutdown(); sent++) {
                            if (!claimAndSend.getAsBoolean()) break;
                        }
                    } catch (RuntimeException exception) {
                        LOGGER.warn("Command dispatch attempt failed: type={}", exception.getClass().getSimpleName());
                    } finally {
                        slots.release();
                    }
                });
            } catch (RejectedExecutionException exception) {
                slots.release();
                if (!executor.isShutdown()) throw exception;
            }
        }
    }

    static void validateLease(Duration connect, Duration read, Duration lease) {
        if (connect.plus(read).plusSeconds(2L * DATABASE_TIMEOUT_SECONDS + 1).compareTo(lease) >= 0) {
            throw new IllegalArgumentException("Outbox lease must exceed connect + read + claim/acknowledgement budgets and margin");
        }
    }

    @Override
    public void close() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(20, TimeUnit.SECONDS)) executor.shutdownNow();
        } catch (InterruptedException exception) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}
