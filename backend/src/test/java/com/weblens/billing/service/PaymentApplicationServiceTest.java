package com.weblens.billing.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.BDDMockito.*;
import static org.mockito.ArgumentMatchers.*;

import com.weblens.billing.config.BillingConfiguration.*;
import com.weblens.billing.gateway.PaymentGateway.*;
import com.weblens.billing.repository.BillingRepository.PaymentOrder;
import com.weblens.common.exception.ApiException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

class PaymentApplicationServiceTest {
    private static final String KEY = "unit-test-signing-key-not-a-credential";
    private static final Instant NOW = Instant.parse("2026-10-13T06:00:00Z");
    private final PaymentTransactionService transactions = mock(PaymentTransactionService.class);
    private final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    private final Profile profile = new Profile(Environment.SANDBOX, "TEST0001", KEY,
            URI.create("https://sandbox.vnpayment.vn/paymentv2/vpcpay.html"), URI.create("https://example.test/return"));
    private final PaymentApplicationService application = new PaymentApplicationService(transactions,
            new Properties("sandbox-v1", Map.of("sandbox-v1", profile), Map.of("starter", new CreditPackage(10_000, "VND", 1_000))),
            meters, Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void malformedSignatureDoesNotReachDatabase() {
        assertThat(application.ipn("sandbox-v1", Map.of("vnp_Amount", List.of("1000000"))).code()).isEqualTo("97");
        then(transactions).shouldHaveNoInteractions();
    }

    @Test
    void commitFailureReturnsRetryCodeNotSuccess() throws Exception {
        given(transactions.accept(eq("sandbox-v1"), any())).willThrow(new org.springframework.transaction.TransactionSystemException("Injected commit failure"));
        assertThat(application.ipn("sandbox-v1", signedIpn()).code()).isEqualTo("99");
        assertThat(meters.find("weblens.billing.ipn").tag("code", "99").counter().count()).isEqualTo(1);
    }

    @Test
    void returnsCommittedResultAndCountsUnknownProfileWithoutDatabase() throws Exception {
        given(transactions.accept(eq("sandbox-v1"), any())).willReturn("00");
        assertThat(application.ipn("sandbox-v1", signedIpn()).code()).isEqualTo("00");
        assertThat(application.ipn("missing", Map.of()).code()).isEqualTo("99");
        assertThat(meters.find("weblens.billing.ipn").tag("code", "00").counter().count()).isEqualTo(1);
    }

    @Test
    void doesNotReturnExpiredCheckoutUrlAndRedactsResponseToString() {
        UUID owner = UUID.randomUUID();
        var order = new PaymentOrder(UUID.randomUUID(), owner, profile.gateway().identity(), "sandbox-v1", "Order123",
                "starter", 10_000, "VND", 1_000, "fixture", "PENDING", null, NOW.minusSeconds(1_800), NOW.minusSeconds(900), null);
        given(transactions.create(owner, "starter", "key")).willReturn(new PaymentTransactionService.CreatedOrder(order, true));
        var response = application.create(owner, "starter", "key", "127.0.0.1");
        assertThat(response.checkoutUrl()).isNull();
        assertThat(response.toString()).isEqualTo("Checkout[redacted]");
    }

    private static Map<String, List<String>> signedIpn() throws Exception {
        var fields = new TreeMap<String, String>();
        fields.put("vnp_Amount", "1000000"); fields.put("vnp_BankCode", "NCB");
        fields.put("vnp_OrderInfo", "WebLens credits"); fields.put("vnp_ResponseCode", "00");
        fields.put("vnp_TmnCode", "TEST0001"); fields.put("vnp_TransactionNo", "99999");
        fields.put("vnp_TransactionStatus", "00"); fields.put("vnp_TxnRef", "Order123");
        var canonical = fields.entrySet().stream().map(e -> e.getKey() + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(java.util.stream.Collectors.joining("&"));
        var mac = Mac.getInstance("HmacSHA512"); mac.init(new SecretKeySpec(KEY.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
        fields.put("vnp_SecureHash", HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8))));
        Map<String, List<String>> query = new LinkedHashMap<>(); fields.forEach((k, v) -> query.put(k, List.of(v))); return query;
    }
}
