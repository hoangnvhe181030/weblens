package com.weblens.billing.model;

import java.util.Objects;

/** Arithmetic only; the application must authenticate, deduplicate and persist terminal evidence. */
public final class UsageBillingPolicy {

    public static final String VERSION = "successful-html-v1";

    public enum TerminalOutcome { COMPLETED, PARTIAL_SUCCESS, USER_CANCELLED, INTERNAL_FAILURE }

    public record Reservation(int maxPages, long creditsPerPage) {
        public Reservation {
            if (maxPages <= 0 || creditsPerPage <= 0) {
                throw new IllegalArgumentException("Reservation limits must be positive");
            }
            Math.multiplyExact((long) maxPages, creditsPerPage);
        }

        public long reservedCredits() { return Math.multiplyExact((long) maxPages, creditsPerPage); }
    }

    /** Count unique HTML 2xx pages with usable published evidence, not crawler succeededCount. */
    public record TerminalEvidence(TerminalOutcome outcome, int publishedBillablePages, boolean publicationComplete) {
        public TerminalEvidence {
            Objects.requireNonNull(outcome, "outcome");
            if (publishedBillablePages < 0) throw new IllegalArgumentException("Page count cannot be negative");
        }
    }

    public record Settlement(int billablePages, long chargedCredits, long releasedCredits) { }

    public Settlement settle(Reservation reservation, TerminalEvidence evidence) {
        Objects.requireNonNull(reservation, "reservation");
        Objects.requireNonNull(evidence, "evidence");
        if (evidence.publishedBillablePages() > reservation.maxPages()) {
            throw new IllegalArgumentException("Billable evidence exceeds reserved page limit");
        }
        if (evidence.outcome() == TerminalOutcome.INTERNAL_FAILURE) {
            return new Settlement(0, 0, reservation.reservedCredits());
        }
        if (!evidence.publicationComplete()) {
            throw new IllegalStateException("Final publication evidence is required before settlement");
        }
        long charged = Math.multiplyExact((long) evidence.publishedBillablePages(), reservation.creditsPerPage());
        return new Settlement(evidence.publishedBillablePages(), charged, reservation.reservedCredits() - charged);
    }
}
