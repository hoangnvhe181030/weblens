package com.weblens.billing.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.net.URI;
import java.time.Instant;
import java.util.UUID;

public final class BillingResponses {
    private BillingResponses() { }

    public record Balance(long balanceCredits, long heldCredits, long availableCredits) { }

    public record Order(UUID id, String packageId, long amountMinor, String currency, long credits,
                        String status, Instant createdAt, Instant expiresAt, Instant settledAt) { }

    public record Checkout(Order order, URI checkoutUrl, boolean replayed) {
        @Override public String toString() { return "Checkout[redacted]"; }
    }

    public record LedgerEntry(long id, String operation, long balanceDelta, long heldDelta,
                              UUID paymentOrderId, UUID reservationScanId, Instant createdAt) { }

    public record Ipn(@JsonProperty("RspCode") String code, @JsonProperty("Message") String message) {
        public static Ipn of(String code) {
            return new Ipn(code, switch (code) {
                case "00" -> "Confirm Success";
                case "02" -> "Order already confirmed";
                case "01" -> "Order not found";
                case "04" -> "Invalid amount";
                case "97" -> "Invalid signature";
                default -> "Unable to confirm";
            });
        }
    }
}
