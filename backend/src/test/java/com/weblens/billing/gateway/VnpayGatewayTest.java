package com.weblens.billing.gateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.billing.gateway.PaymentGateway.Checkout;
import com.weblens.billing.gateway.PaymentGateway.Environment;
import com.weblens.billing.gateway.PaymentGateway.Outcome;
import com.weblens.billing.gateway.VnpayGateway.InvalidNotificationException;
import com.weblens.billing.gateway.VnpayGateway.Reason;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Executors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class VnpayGatewayTest {

    private static final String TEST_KEY = "unit-test-signing-key-not-a-credential";
    private static final URI ENDPOINT = URI.create("https://sandbox.vnpayment.vn/paymentv2/vpcpay.html");
    private static final URI RETURN_URL = URI.create("https://weblens.example/payments/return?source=checkout");
    private static final Instant CREATED = Instant.parse("2026-10-13T03:00:00Z");
    private static final String CHECKOUT_CANONICAL = "vnp_Amount=1000000&vnp_Command=pay"
            + "&vnp_CreateDate=20261013100000&vnp_CurrCode=VND&vnp_ExpireDate=20261013101500"
            + "&vnp_IpAddr=203.0.113.10&vnp_Locale=vn&vnp_OrderInfo=WebLens+credits+Order123"
            + "&vnp_OrderType=other&vnp_ReturnUrl=https%3A%2F%2Fweblens.example%2Fpayments%2Freturn%3Fsource%3Dcheckout"
            + "&vnp_TmnCode=TEST0001&vnp_TxnRef=Order123&vnp_Version=2.1.0";
    // Independently computed with Python hmac/urllib; fixtures contain no merchant credentials.
    private static final String CHECKOUT_HASH = "102e84c8c31166e19a8e54bcaa3c83c1a9b9dd4868bdd84172ffdea4990b6c294"
            + "62a250a010df903f37eb59898f1aca0ca6b744900b4b32e9f2e394cae777ed3";
    private static final String IPN_HASH = "af6238bf4106adbed95fcbc280078f29b44f8efbaa444001bb9717dbc71ce063b9"
            + "7f14f13ce160e2c618fb4c60122da374716b64dc1a45a1cdc8ea45f3c85083";

    private final VnpayGateway gateway = gateway();

    @Test
    void buildsCheckoutUsingIndependentVectorAndVietnamTimezone() {
        assertThat(gateway.checkoutUrl(checkout(10_000)).toASCIIString())
                .isEqualTo(ENDPOINT + "?" + CHECKOUT_CANONICAL + "&vnp_SecureHash=" + CHECKOUT_HASH);
    }

    @Test
    void verifiesIndependentIpnVectorWithoutDoubleDecodingAndNormalizesCurrency() {
        var fields = ipn();
        fields.put("vnp_SecureHash", List.of(IPN_HASH));
        var payment = gateway.verifyIpn(fields);

        assertThat(payment.identity()).isEqualTo(gateway.identity());
        assertThat(payment.reference()).isEqualTo("Order123");
        assertThat(payment.providerTransactionId()).isEqualTo("987654321");
        assertThat(payment.amountMinor()).isEqualTo(10_000);
        assertThat(payment.currency()).isEqualTo("VND");
        assertThat(payment.outcome()).isEqualTo(Outcome.SUCCEEDED);
        assertThat(payment.paidAt()).isEqualTo(Instant.parse("2026-10-13T03:01:02Z"));
    }

    @ParameterizedTest
    @CsvSource({"00,00,SUCCEEDED", "00,02,NOT_SUCCEEDED", "24,00,NOT_SUCCEEDED", "24,02,NOT_SUCCEEDED"})
    void requiresBothSuccessCodes(String response, String status, Outcome expected) throws Exception {
        var fields = ipn();
        fields.put("vnp_ResponseCode", List.of(response));
        fields.put("vnp_TransactionStatus", List.of(status));
        assertThat(gateway.verifyIpn(sign(fields)).outcome()).isEqualTo(expected);
    }

    @Test
    void rejectsTamperedAmountBeforeSemanticProcessing() {
        var fields = ipn();
        fields.put("vnp_SecureHash", List.of(IPN_HASH));
        fields.put("vnp_Amount", List.of("2000000"));
        assertRejected(fields, Reason.SIGNATURE);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "abc", "gg", "00"})
    void rejectsInvalidSignatureEncoding(String signature) {
        var fields = ipn();
        fields.put("vnp_SecureHash", List.of(signature));
        assertRejected(fields, Reason.SIGNATURE);
    }

    @Test
    void rejectsValidSignatureForWrongMerchant() throws Exception {
        var fields = ipn();
        fields.put("vnp_TmnCode", List.of("OTHER001"));
        assertRejected(sign(fields), Reason.MERCHANT_MISMATCH);
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "1000001", "-100", "1.00", "1000000000000", "1000000 "})
    void rejectsSignedInvalidOrFractionalVndAmounts(String amount) throws Exception {
        var fields = ipn();
        fields.put("vnp_Amount", List.of(amount));
        assertRejected(sign(fields), Reason.MALFORMED);
    }

    @Test
    void rejectsDuplicateQueryFieldsInsteadOfChoosingFirstOrLast() {
        var fields = ipn();
        fields.put("vnp_SecureHash", List.of(IPN_HASH));
        fields.put("vnp_Amount", List.of("1000000", "2000000"));
        assertRejected(fields, Reason.MALFORMED);
    }

    @Test
    void signsFutureFieldsAndIgnoresUnsignedNonProviderFields() throws Exception {
        var fields = ipn();
        fields.put("vnp_Future", List.of("value+with%encoding"));
        fields.put("utm_source", List.of("not settlement data"));
        fields.put("vnp_SecureHashType", List.of("legacy metadata"));
        fields.put("vnp_OptionalEmpty", List.of(""));
        sign(fields);
        assertThat(gateway.verifyIpn(fields).outcome()).isEqualTo(Outcome.SUCCEEDED);
        fields.put("vnp_Future", List.of("altered"));
        assertRejected(fields, Reason.SIGNATURE);
    }

    @ParameterizedTest
    @CsvSource({"vnp_TxnRef,bad-ref!", "vnp_TransactionNo,abc", "vnp_ResponseCode,000",
            "vnp_TransactionStatus,0", "vnp_BankCode,N", "vnp_PayDate,20260230120101", "vnp_CurrCode,USD"})
    void rejectsSignedInvalidRequiredFields(String field, String value) throws Exception {
        var fields = ipn();
        fields.put(field, List.of(value));
        assertRejected(sign(fields), Reason.MALFORMED);
    }

    @Test
    void rejectsMissingRequiredFieldAfterSignatureVerification() throws Exception {
        var fields = ipn();
        fields.remove("vnp_OrderInfo");
        assertRejected(sign(fields), Reason.MALFORMED);
    }

    @Test
    void acceptsAbsentPayDateAndDoesNotRejectLateIpnByWallClock() throws Exception {
        var fields = ipn();
        fields.remove("vnp_PayDate");
        assertThat(gateway.verifyIpn(sign(fields)).paidAt()).isNull();
        fields.put("vnp_PayDate", List.of("20200101120000"));
        assertThat(gateway.verifyIpn(sign(fields)).paidAt()).isEqualTo(Instant.parse("2020-01-01T05:00:00Z"));
    }

    @Test
    void boundsUntrustedInput() {
        var oversizedValue = ipn();
        oversizedValue.put("vnp_Extra", List.of("x".repeat(1_025)));
        assertRejected(oversizedValue, Reason.MALFORMED);
        var oversizedQuery = ipn();
        for (int i = 0; i < 9; i++) oversizedQuery.put("vnp_Extra" + i, List.of("x".repeat(1_024)));
        assertRejected(oversizedQuery, Reason.MALFORMED);
        var tooMany = ipn();
        for (int i = 0; i < 49; i++) tooMany.put("vnp_Extra" + i, List.of("x"));
        assertRejected(tooMany, Reason.MALFORMED);
    }

    @ParameterizedTest
    @ValueSource(longs = {10_000_000_000L, Long.MAX_VALUE})
    void rejectsAmountsBeyondWireLimitWithoutOverflow(long amount) {
        assertThatThrownBy(() -> gateway.checkoutUrl(checkout(amount))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void supportsMaximumAmountExactly() {
        assertThat(gateway.checkoutUrl(checkout(9_999_999_999L)).toString())
                .contains("vnp_Amount=999999999900&");
    }

    @ParameterizedTest
    @ValueSource(strings = {"client.example", "256.1.1.1", "127.1", "1.2.3.4,5.6.7.8", "fe80::1%eth0"})
    void rejectsHostnamesAndUntrustedForwardedIp(String ip) {
        var checkout = new Checkout("Order123", 10_000, "VND", CREATED, CREATED.plusSeconds(900), ip);
        assertThatThrownBy(() -> gateway.checkoutUrl(checkout)).isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"2001:db8::1", "::ffff:203.0.113.10"})
    void acceptsIpv6LiteralIncludingMappedIpv4(String ip) {
        var checkout = new Checkout("Order123", 10_000, "VND", CREATED, CREATED.plusSeconds(900), ip);
        assertThat(gateway.checkoutUrl(checkout).toString())
                .contains("vnp_IpAddr=" + URLEncoder.encode(ip, StandardCharsets.UTF_8));
    }

    @Test
    void rejectsNullQueryAndNullQueryValueSafely() {
        assertRejected(null, Reason.MALFORMED);
        var fields = ipn();
        fields.put("vnp_Amount", java.util.Collections.singletonList(null));
        assertRejected(fields, Reason.MALFORMED);
    }

    @Test
    void rejectsUnsupportedCurrencyReferenceAndExpiry() {
        assertThatThrownBy(() -> gateway.checkoutUrl(new Checkout("Order123", 10_000, "USD", CREATED,
                CREATED.plusSeconds(900), "203.0.113.10"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> gateway.checkoutUrl(new Checkout("Order-123", 10_000, "VND", CREATED,
                CREATED.plusSeconds(900), "203.0.113.10"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> gateway.checkoutUrl(new Checkout("Order123", 10_000, "VND", CREATED,
                CREATED.plusSeconds(901), "203.0.113.10"))).isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"http://weblens.example/return", "https://user:pass@weblens.example/return",
            "https://weblens.example/return#fragment", "https://weblens.example:8443/return"})
    void rejectsUnsafeReturnConfiguration(String url) {
        assertThatThrownBy(() -> new VnpayGateway(Environment.SANDBOX, "TEST0001", TEST_KEY,
                ENDPOINT, URI.create(url))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsEnvironmentMismatchAndDoesNotExposeSecretInDiagnostics() {
        assertThatThrownBy(() -> new VnpayGateway(Environment.LIVE, "TEST0001", TEST_KEY, ENDPOINT, RETURN_URL))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VnpayGateway(Environment.SANDBOX, "TEST0001", "short", ENDPOINT, RETURN_URL))
                .isInstanceOf(IllegalArgumentException.class).hasMessageNotContaining("short");
        assertThat(gateway.toString()).doesNotContain(TEST_KEY);
    }

    @Test
    void verifiesRepeatedIpnsConcurrentlyWithoutSharedMacState() throws Exception {
        var fields = Map.copyOf(sign(ipn()));
        try (var executor = Executors.newFixedThreadPool(8)) {
            var futures = java.util.stream.IntStream.range(0, 64)
                    .mapToObj(i -> executor.submit(() -> gateway.verifyIpn(fields))).toList();
            for (var future : futures) assertThat(future.get()).isEqualTo(gateway.verifyIpn(fields));
        }
        // This checks parser thread safety, not database idempotency or load capacity.
    }

    private void assertRejected(Map<String, List<String>> fields, Reason reason) {
        assertThatThrownBy(() -> gateway.verifyIpn(fields)).isInstanceOf(InvalidNotificationException.class)
                .extracting(exception -> ((InvalidNotificationException) exception).reason()).isEqualTo(reason);
    }

    private static Checkout checkout(long amount) {
        return new Checkout("Order123", amount, "VND", CREATED, CREATED.plusSeconds(900), "203.0.113.10");
    }

    private static VnpayGateway gateway() {
        return new VnpayGateway(Environment.SANDBOX, "TEST0001", TEST_KEY, ENDPOINT, RETURN_URL);
    }

    private static Map<String, List<String>> ipn() {
        Map<String, List<String>> fields = new LinkedHashMap<>();
        fields.put("vnp_Amount", List.of("1000000"));
        fields.put("vnp_BankCode", List.of("NCB"));
        fields.put("vnp_OrderInfo", List.of("WebLens order 100% + test"));
        fields.put("vnp_PayDate", List.of("20261013100102"));
        fields.put("vnp_ResponseCode", List.of("00"));
        fields.put("vnp_TmnCode", List.of("TEST0001"));
        fields.put("vnp_TransactionNo", List.of("987654321"));
        fields.put("vnp_TransactionStatus", List.of("00"));
        fields.put("vnp_TxnRef", List.of("Order123"));
        return fields;
    }

    private static Map<String, List<String>> sign(Map<String, List<String>> fields) throws Exception {
        TreeMap<String, String> sorted = new TreeMap<>();
        fields.forEach((key, values) -> {
            if (key.startsWith("vnp_") && !key.equals("vnp_SecureHash") && !key.equals("vnp_SecureHashType")
                    && !values.getFirst().isEmpty()) sorted.put(key, values.getFirst());
        });
        String canonical = sorted.entrySet().stream().map(entry -> URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8)
                + "=" + URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8))
                .collect(java.util.stream.Collectors.joining("&"));
        Mac mac = Mac.getInstance("HmacSHA512");
        mac.init(new SecretKeySpec(TEST_KEY.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
        fields.put("vnp_SecureHash", List.of(HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)))));
        return fields;
    }
}
