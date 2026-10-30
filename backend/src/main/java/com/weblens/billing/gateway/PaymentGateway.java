package com.weblens.billing.gateway;

import java.net.URI;
import java.time.Instant;
import java.util.Objects;

/** Provider protocol stays in the adapter; wallet settlement consumes normalized notifications. */
public interface PaymentGateway {

    ProviderIdentity identity();

    /** The caller must commit the immutable order before exposing this URL. Never log the URL. */
    URI checkoutUrl(Checkout checkout);

    enum Environment { SANDBOX, LIVE }

    // A non-success notification is not proof that the provider can never settle this order later.
    enum Outcome { SUCCEEDED, NOT_SUCCEEDED }

    record ProviderIdentity(String provider, Environment environment, String merchantAccount) {
        public ProviderIdentity {
            Objects.requireNonNull(environment, "environment");
            if (provider == null || !provider.matches("[A-Z0-9_]{1,32}")
                    || merchantAccount == null || !merchantAccount.matches("[A-Za-z0-9_-]{1,100}")) {
                throw new IllegalArgumentException("Invalid provider identity");
            }
        }
    }

    /** amountMinor uses the currency exponent: VND has exponent zero, not VNPAY's wire scale. */
    record Checkout(
            String reference, long amountMinor, String currency,
            Instant createdAt, Instant expiresAt, String clientIp
    ) {
        public Checkout {
            if (reference == null || reference.isBlank() || reference.length() > 100
                    || amountMinor <= 0 || currency == null || !currency.matches("[A-Z]{3}")) {
                throw new IllegalArgumentException("Invalid checkout");
            }
            Objects.requireNonNull(createdAt, "createdAt");
            Objects.requireNonNull(expiresAt, "expiresAt");
            Objects.requireNonNull(clientIp, "clientIp");
            if (!expiresAt.isAfter(createdAt)) {
                throw new IllegalArgumentException("Checkout expiry must follow creation");
            }
        }
    }

    /** Signature verification alone is not settlement: compare the persisted order inside a transaction. */
    record VerifiedPayment(
            ProviderIdentity identity, String reference, String providerTransactionId,
            long amountMinor, String currency, Outcome outcome, Instant paidAt
    ) {
        public VerifiedPayment {
            Objects.requireNonNull(identity, "identity");
            Objects.requireNonNull(outcome, "outcome");
            if (reference == null || reference.isBlank() || providerTransactionId == null
                    || providerTransactionId.isBlank() || amountMinor <= 0
                    || currency == null || !currency.matches("[A-Z]{3}")) {
                throw new IllegalArgumentException("Invalid verified payment");
            }
        }
    }
}
