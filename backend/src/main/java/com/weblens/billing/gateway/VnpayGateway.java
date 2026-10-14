package com.weblens.billing.gateway;

import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.stream.Collectors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** VNPAY protocol adapter; the feature-gated billing facade owns activation and settlement. */
public final class VnpayGateway implements PaymentGateway {

    private static final ZoneId VIETNAM = ZoneId.of("Asia/Ho_Chi_Minh");
    private static final DateTimeFormatter TIMESTAMP = DateTimeFormatter.ofPattern("uuuuMMddHHmmss")
            .withResolverStyle(ResolverStyle.STRICT);
    private static final long MAX_AMOUNT_VND = 9_999_999_999L;
    private static final int MAX_FIELDS = 48;
    private static final int MAX_DECODED_CHARACTERS = 8_192;

    private final ProviderIdentity identity;
    private final URI checkoutEndpoint;
    private final URI returnUrl;
    private final byte[] secret;

    public VnpayGateway(Environment environment, String merchantAccount, String hashSecret,
            URI checkoutEndpoint, URI returnUrl) {
        identity = new ProviderIdentity("VNPAY", environment, merchantAccount);
        if (!merchantAccount.matches("[A-Za-z0-9]{8}") || hashSecret == null
                || !hashSecret.matches("[\\x21-\\x7E]{16,256}")) {
            throw new IllegalArgumentException("Invalid VNPAY credentials");
        }
        requireHttps(checkoutEndpoint);
        requireHttps(returnUrl);
        if (checkoutEndpoint.getRawQuery() != null || returnUrl.toASCIIString().length() > 255) {
            throw new IllegalArgumentException("Invalid VNPAY endpoint configuration");
        }
        boolean sandboxHost = "sandbox.vnpayment.vn".equalsIgnoreCase(checkoutEndpoint.getHost());
        if ((environment == Environment.SANDBOX && (!sandboxHost
                || !"/paymentv2/vpcpay.html".equals(checkoutEndpoint.getPath())))
                || (environment == Environment.LIVE && sandboxHost)) {
            throw new IllegalArgumentException("VNPAY endpoint does not match environment");
        }
        this.checkoutEndpoint = checkoutEndpoint;
        this.returnUrl = returnUrl;
        secret = hashSecret.getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public ProviderIdentity identity() {
        return identity;
    }

    @Override
    public URI checkoutUrl(Checkout checkout) {
        Objects.requireNonNull(checkout, "checkout");
        if (!checkout.reference().matches("[A-Za-z0-9]{1,100}")
                || !"VND".equals(checkout.currency()) || checkout.amountMinor() > MAX_AMOUNT_VND) {
            throw new IllegalArgumentException("Unsupported VNPAY checkout");
        }
        requireIpLiteral(checkout.clientIp());
        var created = checkout.createdAt().truncatedTo(ChronoUnit.SECONDS);
        var expires = checkout.expiresAt().truncatedTo(ChronoUnit.SECONDS);
        if (!expires.isAfter(created) || Duration.between(created, expires).compareTo(Duration.ofMinutes(15)) > 0) {
            throw new IllegalArgumentException("VNPAY checkout lifetime must be positive and at most 15 minutes");
        }
        TreeMap<String, String> fields = new TreeMap<>();
        fields.put("vnp_Version", "2.1.0");
        fields.put("vnp_Command", "pay");
        fields.put("vnp_TmnCode", identity.merchantAccount());
        fields.put("vnp_Amount", Long.toString(Math.multiplyExact(checkout.amountMinor(), 100)));
        fields.put("vnp_CurrCode", "VND");
        fields.put("vnp_TxnRef", checkout.reference());
        fields.put("vnp_OrderInfo", "WebLens credits " + checkout.reference());
        fields.put("vnp_OrderType", "other");
        fields.put("vnp_Locale", "vn");
        fields.put("vnp_IpAddr", checkout.clientIp());
        fields.put("vnp_ReturnUrl", returnUrl.toASCIIString());
        fields.put("vnp_CreateDate", formatTimestamp(created));
        fields.put("vnp_ExpireDate", formatTimestamp(expires));
        String canonical = canonical(fields);
        return URI.create(checkoutEndpoint.toASCIIString() + "?" + canonical
                + "&vnp_SecureHash=" + HexFormat.of().formatHex(hmac(canonical)));
    }

    /** Accept a decoded-once query multimap, not a Map that has already discarded duplicate keys. */
    public VerifiedPayment verifyIpn(Map<String, List<String>> decodedQuery) {
        TreeMap<String, String> fields = boundedFields(decodedQuery);
        String signature = fields.remove("vnp_SecureHash");
        fields.remove("vnp_SecureHashType");
        if (signature == null || !signature.matches("[A-Fa-f0-9]{128}")
                || !MessageDigest.isEqual(hmac(canonical(fields)), HexFormat.of().parseHex(signature))) {
            throw invalid(Reason.SIGNATURE);
        }
        if (!identity.merchantAccount().equals(required(fields, "vnp_TmnCode", "[A-Za-z0-9]{8}"))) {
            throw invalid(Reason.MERCHANT_MISMATCH);
        }
        String amount = required(fields, "vnp_Amount", "[0-9]{1,12}");
        long scaled = Long.parseLong(amount);
        if (scaled <= 0 || scaled % 100 != 0) throw invalid(Reason.MALFORMED);
        if (fields.containsKey("vnp_CurrCode") && !"VND".equals(fields.get("vnp_CurrCode"))) {
            throw invalid(Reason.MALFORMED);
        }
        String reference = required(fields, "vnp_TxnRef", "[A-Za-z0-9]{1,100}");
        String transactionId = required(fields, "vnp_TransactionNo", "[0-9]{1,15}");
        required(fields, "vnp_BankCode", "[A-Za-z0-9]{3,20}");
        required(fields, "vnp_OrderInfo", "[^\\p{Cntrl}]{1,255}");
        String response = required(fields, "vnp_ResponseCode", "[0-9]{2}");
        String status = required(fields, "vnp_TransactionStatus", "[0-9]{2}");
        Instant paidAt = null;
        if (fields.containsKey("vnp_PayDate")) {
            String date = required(fields, "vnp_PayDate", "[0-9]{14}");
            try {
                paidAt = LocalDateTime.parse(date, TIMESTAMP).atZone(VIETNAM).toInstant();
            } catch (DateTimeParseException exception) {
                throw invalid(Reason.MALFORMED);
            }
        }
        // IPNs can arrive after checkout expiry. Order/reconciliation policy, not this parser, decides settlement.
        return new VerifiedPayment(identity, reference, transactionId, scaled / 100, "VND",
                "00".equals(response) && "00".equals(status) ? Outcome.SUCCEEDED : Outcome.NOT_SUCCEEDED, paidAt);
    }

    private static TreeMap<String, String> boundedFields(Map<String, List<String>> query) {
        if (query == null || query.isEmpty() || query.size() > MAX_FIELDS) throw invalid(Reason.MALFORMED);
        int characters = 0;
        TreeMap<String, String> fields = new TreeMap<>();
        for (var entry : query.entrySet()) {
            String name = entry.getKey();
            List<String> values = entry.getValue();
            if (name == null || !name.matches("[A-Za-z0-9_]{1,64}") || values == null
                    || values.size() != 1 || values.getFirst() == null || values.getFirst().length() > 1_024) {
                throw invalid(Reason.MALFORMED);
            }
            String value = values.getFirst();
            characters += name.length() + value.length();
            if (characters > MAX_DECODED_CHARACTERS) throw invalid(Reason.MALFORMED);
            if (name.startsWith("vnp_") && !value.isEmpty()) fields.put(name, value);
        }
        return fields;
    }

    private static String required(Map<String, String> fields, String name, String pattern) {
        String value = fields.get(name);
        if (value == null || !value.matches(pattern)) throw invalid(Reason.MALFORMED);
        return value;
    }

    private static String canonical(Map<String, String> fields) {
        return fields.entrySet().stream()
                .map(entry -> encode(entry.getKey()) + "=" + encode(entry.getValue()))
                .collect(Collectors.joining("&"));
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private byte[] hmac(String canonical) {
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(secret, "HmacSHA512"));
            return mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("VNPAY signing unavailable", exception);
        }
    }

    private static String formatTimestamp(Instant instant) {
        String timestamp = TIMESTAMP.format(instant.atZone(VIETNAM));
        if (!timestamp.matches("[0-9]{14}")) throw new IllegalArgumentException("Unsupported checkout date");
        return timestamp;
    }

    private static void requireHttps(URI uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) {
            throw new IllegalArgumentException("Payment URLs must use HTTPS without user info or fragments");
        }
    }

    private static void requireIpLiteral(String ip) {
        if (ip.length() > 45 || !(ip.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")
                || (ip.contains(":") && ip.matches("[A-Fa-f0-9:.]+")))) {
            throw new IllegalArgumentException("Client IP must be a literal address");
        }
        try {
            // The lexical check excludes hostnames, so this never performs a DNS lookup.
            InetAddress.getByName(ip);
        } catch (UnknownHostException exception) {
            throw new IllegalArgumentException("Invalid client IP");
        }
    }

    public enum Reason { SIGNATURE, MALFORMED, MERCHANT_MISMATCH }

    public static final class InvalidNotificationException extends IllegalArgumentException {
        private final Reason reason;

        private InvalidNotificationException(Reason reason) {
            super("Invalid VNPAY notification: " + reason);
            this.reason = reason;
        }

        public Reason reason() { return reason; }
    }

    private static InvalidNotificationException invalid(Reason reason) {
        return new InvalidNotificationException(reason);
    }
}
