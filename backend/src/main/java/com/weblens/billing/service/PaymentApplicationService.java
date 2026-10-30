package com.weblens.billing.service;

import com.weblens.billing.config.BillingConfiguration.Properties;
import com.weblens.billing.dto.BillingResponses;
import com.weblens.billing.gateway.PaymentGateway.Checkout;
import com.weblens.billing.gateway.VnpayGateway;
import com.weblens.common.exception.ApiException;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** No outer transaction: checkout is exposed and IPN acknowledged only after the proxied service commits. */
@Service
@ConditionalOnProperty(name = "weblens.billing.enabled", havingValue = "true")
@Transactional(propagation = Propagation.NEVER)
public class PaymentApplicationService {
    private final PaymentTransactionService transactions;
    private final Map<String, VnpayGateway> gateways;
    private final MeterRegistry meters;
    private final Clock clock;

    public PaymentApplicationService(PaymentTransactionService transactions, Properties properties, MeterRegistry meters, Clock clock) {
        this.transactions = transactions; this.meters = meters; this.clock = clock;
        gateways = properties.profiles().entrySet().stream().collect(Collectors.toUnmodifiableMap(Map.Entry::getKey, e -> e.getValue().gateway()));
    }

    public BillingResponses.Checkout create(UUID owner, String packageId, String key, String clientIp) {
        var created = transactions.create(owner, packageId, key);
        var order = created.order();
        var gateway = gateways.get(order.profileId());
        if (gateway == null || !gateway.identity().equals(order.identity())) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "PAYMENT_PROFILE_UNAVAILABLE", "Payment unavailable", "The original payment profile is unavailable.");
        }
        return new BillingResponses.Checkout(order.response(), "PAID".equals(order.status()) || !order.expiresAt().isAfter(clock.instant())
                ? null : gateway.checkoutUrl(
                new Checkout(order.reference(), order.amountMinor(), order.currency(), order.createdAt(), order.expiresAt(), clientIp)), created.replayed());
    }

    public BillingResponses.Ipn ipn(String profileId, Map<String, List<String>> query) {
        String code;
        try {
            var gateway = gateways.get(profileId);
            if (gateway == null) {
                code = "99";
            } else {
                var verified = gateway.verifyIpn(query);
                code = transactions.accept(profileId, verified);
            }
        } catch (VnpayGateway.InvalidNotificationException exception) {
            code = exception.reason() == VnpayGateway.Reason.SIGNATURE ? "97" : "99";
        } catch (RuntimeException exception) {
            // Never log SQL bind parameters, raw callback or provider/query exceptions here.
            code = "99";
        }
        meters.counter("weblens.billing.ipn", "provider", "VNPAY", "environment", "SANDBOX", "code", code).increment();
        return BillingResponses.Ipn.of(code);
    }
}
