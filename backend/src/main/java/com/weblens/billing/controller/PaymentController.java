package com.weblens.billing.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.billing.dto.BillingResponses;
import com.weblens.billing.service.PaymentApplicationService;
import com.weblens.billing.service.PaymentTransactionService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/billing")
@ConditionalOnProperty(name = "weblens.billing.enabled", havingValue = "true")
public class PaymentController {
    private final PaymentApplicationService application;
    private final PaymentTransactionService transactions;

    public PaymentController(PaymentApplicationService application, PaymentTransactionService transactions) {
        this.application = application; this.transactions = transactions;
    }

    @PostMapping("/payment-orders")
    public ResponseEntity<BillingResponses.Checkout> create(@AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody CreatePayment body, @RequestHeader("Idempotency-Key") String key,
            HttpServletRequest request) {
        var result = application.create(AuthenticatedUserId.from(jwt), body.packageId(), key, request.getRemoteAddr());
        return ResponseEntity.status(result.replayed() ? 200 : 201)
                .location(URI.create("/api/v1/billing/payment-orders/" + result.order().id()))
                .cacheControl(CacheControl.noStore()).body(result);
    }

    @GetMapping("/payment-orders/{id}")
    public ResponseEntity<BillingResponses.Order> order(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(transactions.order(AuthenticatedUserId.from(jwt), id));
    }

    @GetMapping("/balance")
    public ResponseEntity<BillingResponses.Balance> balance(@AuthenticationPrincipal Jwt jwt) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(transactions.balance(AuthenticatedUserId.from(jwt)));
    }

    @GetMapping("/ledger")
    public ResponseEntity<List<BillingResponses.LedgerEntry>> history(@AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) Instant beforeTime, @RequestParam(required = false) Long beforeId,
            @RequestParam(defaultValue = "20") int limit) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(transactions.history(AuthenticatedUserId.from(jwt), beforeTime, beforeId, limit));
    }

    @GetMapping("/vnpay/{profileId}/ipn")
    public ResponseEntity<BillingResponses.Ipn> ipn(@PathVariable String profileId,
            @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
        // Bound the raw representation as well as the adapter's decoded multimap.
        var result = request.getQueryString() != null && request.getQueryString().length() > 16_384
                ? BillingResponses.Ipn.of("99") : application.ipn(profileId, query);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(result);
    }

    public record CreatePayment(@NotBlank @Pattern(regexp = "[a-z0-9-]{1,40}") String packageId) { }
}
