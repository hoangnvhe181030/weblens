package com.weblens.billing.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.billing.config.BillingConfiguration.Properties;
import com.weblens.billing.dto.BillingResponses;
import com.weblens.billing.gateway.PaymentGateway.Outcome;
import com.weblens.billing.gateway.PaymentGateway.VerifiedPayment;
import com.weblens.billing.repository.BillingRepository;
import com.weblens.billing.repository.BillingRepository.PaymentOrder;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.scan.service.IdempotencyKeyService;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "weblens.billing.enabled", havingValue = "true")
@Transactional(readOnly = true, timeout = 5)
public class PaymentTransactionService {
    private final BillingRepository billing;
    private final CurrentUserService users;
    private final IdempotencyKeyService keys;
    private final Properties properties;
    private final Clock clock;

    public PaymentTransactionService(BillingRepository billing, CurrentUserService users, IdempotencyKeyService keys,
                                     Properties properties, Clock clock) {
        this.billing = billing; this.users = users; this.keys = keys; this.properties = properties; this.clock = clock;
    }

    @Transactional(timeout = 5)
    public CreatedOrder create(UUID owner, String packageId, String rawKey) {
        String key = keys.hashOptional(rawKey);
        if (key == null) throw new ApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED", "Missing key", "Idempotency-Key is required.");
        String fingerprint = keys.fingerprint("billing-topup-v1", packageId);
        billing.databaseBudget();
        users.lockActive(owner);
        var existing = billing.byKey(owner, key);
        if (existing.isPresent()) {
            if (!existing.get().fingerprint().equals(fingerprint)) {
                throw new ConflictException("IDEMPOTENCY_KEY_REUSED", "The key belongs to a different payment request.");
            }
            return new CreatedOrder(existing.get(), true);
        }
        var creditPackage = properties.packages().get(packageId);
        if (creditPackage == null) throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_CREDIT_PACKAGE", "Invalid package", "Choose a configured credit package.");
        var identity = properties.profiles().get(properties.activeProfile()).gateway().identity();
        UUID id = UUID.randomUUID();
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        var order = new PaymentOrder(id, owner, identity, properties.activeProfile(), id.toString().replace("-", ""),
                packageId, creditPackage.amountMinor(), creditPackage.currency(), creditPackage.credits(), fingerprint,
                "PENDING", null, now, now.plusSeconds(900), null);
        billing.ensureAccount(owner);
        billing.insert(order, key);
        return new CreatedOrder(order, false);
    }

    @Transactional(timeout = 5)
    public String accept(String profileId, VerifiedPayment payment) {
        billing.databaseBudget();
        var found = billing.lockOrder(payment.identity(), payment.reference());
        if (found.isEmpty()) return "01";
        PaymentOrder order = found.get();
        if (!order.profileId().equals(profileId)) return "99";
        if (order.amountMinor() != payment.amountMinor() || !order.currency().equals(payment.currency())) return "04";
        if ("PAID".equals(order.status())) {
            return payment.outcome() == Outcome.SUCCEEDED && order.transactionId().equals(payment.providerTransactionId()) ? "02" : "99";
        }
        if (payment.outcome() == Outcome.SUCCEEDED) {
            billing.credit(order, payment.providerTransactionId(), payment.paidAt(), clock.instant());
        } else {
            billing.recordNotSucceeded(order.id());
        }
        // The Spring transaction interceptor commits before this result reaches the IPN facade.
        return "00";
    }

    public BillingResponses.Order order(UUID owner, UUID id) {
        users.requireActive(owner);
        return billing.ownedOrder(owner, id).orElseThrow(() -> new NotFoundException("PAYMENT_NOT_FOUND", "Payment order not found.")).response();
    }

    public BillingResponses.Balance balance(UUID owner) {
        users.requireActive(owner);
        return billing.balance(owner);
    }

    public List<BillingResponses.LedgerEntry> history(UUID owner, Instant beforeTime, Long beforeId, int limit) {
        users.requireActive(owner);
        if (limit < 1 || limit > 100 || (beforeTime == null) != (beforeId == null) || (beforeId != null && beforeId < 1)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_LEDGER_CURSOR", "Invalid cursor", "Use a complete cursor and limit 1 to 100.");
        }
        return billing.history(owner, beforeTime == null ? Instant.parse("9999-12-31T00:00:00Z") : beforeTime,
                beforeId == null ? Long.MAX_VALUE : beforeId, limit);
    }

    public record CreatedOrder(PaymentOrder order, boolean replayed) { }
}
