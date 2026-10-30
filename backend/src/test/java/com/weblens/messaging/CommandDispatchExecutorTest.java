package com.weblens.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class CommandDispatchExecutorTest {

    @Test
    void occupiedSendersDoNotClaimOrQueueMoreWork() throws Exception {
        var entered = new CountDownLatch(4);
        var release = new CountDownLatch(1);
        var calls = new AtomicInteger();
        try (var executor = new CommandDispatchExecutor("test-dispatch", 4)) {
            java.util.function.BooleanSupplier send = () -> {
                calls.incrementAndGet();
                entered.countDown();
                try {
                    if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test sender timed out");
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                }
                return false;
            };
            try {
                executor.poll(send);
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
                for (int index = 0; index < 20; index++) executor.poll(send);
                assertThat(calls).hasValue(4);
            } finally {
                release.countDown();
            }
        }
        assertThat(calls).hasValue(4);
    }

    @Test
    void failedAttemptReleasesCapacityAndShutdownStopsClaims() throws Exception {
        var calls = new AtomicInteger();
        var executor = new CommandDispatchExecutor("test-dispatch", 1);
        executor.poll(() -> {
            calls.incrementAndGet();
            throw new IllegalStateException("Transport failed");
        });
        var recovered = new CountDownLatch(1);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (recovered.getCount() != 0 && System.nanoTime() < deadline) {
            executor.poll(() -> { recovered.countDown(); return false; });
            recovered.await(10, TimeUnit.MILLISECONDS);
        }
        executor.close();
        assertThat(recovered.getCount()).isZero();
        executor.poll(() -> { calls.incrementAndGet(); return false; });
        assertThat(calls).hasValue(1);
    }

    @Test
    void rejectsTimeoutBudgetsThatConsumeTheLease() {
        assertThatThrownBy(() -> CommandDispatchExecutor.validateLease(
                Duration.ofSeconds(2), Duration.ofSeconds(10), Duration.ofSeconds(10)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CommandDispatchExecutor.validateLease(
                Duration.ofSeconds(2), Duration.ofSeconds(10), Duration.ofSeconds(20)))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
