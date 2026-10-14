package com.weblens.billing.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.billing.model.UsageBillingPolicy.Reservation;
import com.weblens.billing.model.UsageBillingPolicy.Settlement;
import com.weblens.billing.model.UsageBillingPolicy.TerminalEvidence;
import com.weblens.billing.model.UsageBillingPolicy.TerminalOutcome;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class UsageBillingPolicyTest {

    private final UsageBillingPolicy policy = new UsageBillingPolicy();

    @ParameterizedTest
    @EnumSource(value = TerminalOutcome.class, names = {"COMPLETED", "PARTIAL_SUCCESS", "USER_CANCELLED"})
    void chargesOnlyPublishedPagesAndReleasesRemainder(TerminalOutcome outcome) {
        assertThat(policy.settle(new Reservation(100, 2), new TerminalEvidence(outcome, 37, true)))
                .isEqualTo(new Settlement(37, 74, 126));
    }

    @Test
    void internalFailureReleasesEverythingEvenWithPartialPublishedEvidence() {
        assertThat(policy.settle(new Reservation(100, 2), new TerminalEvidence(TerminalOutcome.INTERNAL_FAILURE, 37, false)))
                .isEqualTo(new Settlement(0, 0, 200));
    }

    @Test
    void cancellationBeforeAnyPublishedPageIsFree() {
        assertThat(policy.settle(new Reservation(100, 1), new TerminalEvidence(TerminalOutcome.USER_CANCELLED, 0, true)))
                .isEqualTo(new Settlement(0, 0, 100));
    }

    @ParameterizedTest
    @EnumSource(value = TerminalOutcome.class, names = {"COMPLETED", "PARTIAL_SUCCESS", "USER_CANCELLED"})
    void refusesToBillUnconfirmedPublication(TerminalOutcome outcome) {
        assertThatThrownBy(() -> policy.settle(new Reservation(100, 1), new TerminalEvidence(outcome, 37, false)))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsContradictoryEvidenceAndOverflow() {
        assertThatThrownBy(() -> new Reservation(0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Reservation(100, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Reservation(100, Long.MAX_VALUE)).isInstanceOf(ArithmeticException.class);
        assertThatThrownBy(() -> new TerminalEvidence(TerminalOutcome.COMPLETED, -1, true))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> policy.settle(new Reservation(100, 1), new TerminalEvidence(TerminalOutcome.COMPLETED, 101, true)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void conservesReservationAcrossEveryPossibleCount() {
        var reservation = new Reservation(1_000, 7);
        for (int pages = 0; pages <= 1_000; pages++) {
            var settlement = policy.settle(reservation, new TerminalEvidence(TerminalOutcome.PARTIAL_SUCCESS, pages, true));
            assertThat(settlement.chargedCredits() + settlement.releasedCredits()).isEqualTo(reservation.reservedCredits());
            assertThat(settlement.chargedCredits()).isBetween(0L, reservation.reservedCredits());
        }
    }
}
