package com.weblens.billing.controller;

import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.ArgumentMatchers.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.weblens.auth.security.*;
import com.weblens.billing.dto.BillingResponses;
import com.weblens.billing.service.PaymentApplicationService;
import com.weblens.billing.service.PaymentTransactionService;
import com.weblens.common.config.CorsProperties;
import com.weblens.common.exception.NotFoundException;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(value = PaymentController.class, properties = "weblens.billing.enabled=true")
@Import({SecurityConfig.class, DoubleSubmitCsrfFilter.class, ProblemAuthenticationEntryPoint.class,
        ProblemAccessDeniedHandler.class, ProblemDetailsFactory.class, ProblemResponseWriter.class,
        PaymentControllerTest.TestBeans.class})
class PaymentControllerTest {
    @Autowired MockMvc mvc;
    @MockitoBean PaymentApplicationService application;
    @MockitoBean PaymentTransactionService transactions;
    @MockitoBean JwtDecoder decoder;

    @Test
    void userEndpointsRequireAuthentication() throws Exception {
        mvc.perform(get("/api/v1/billing/balance")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/billing/payment-orders/" + UUID.randomUUID())).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/billing/ledger")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/billing/payment-orders").contentType("application/json").content("{\"packageId\":\"starter\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void createsOwnerScopedOrderWithNoStoreAndLocation() throws Exception {
        UUID owner = UUID.randomUUID(), order = UUID.randomUUID();
        var response = new BillingResponses.Order(order, "starter", 10_000, "VND", 1_000, "PENDING",
                Instant.now(), Instant.now().plusSeconds(900), null);
        given(application.create(eq(owner), eq("starter"), eq("request-key"), anyString()))
                .willReturn(new BillingResponses.Checkout(response, URI.create("https://example.test/checkout"), false));
        mvc.perform(post("/api/v1/billing/payment-orders").with(jwt().jwt(j -> j.subject(owner.toString())))
                        .header("Idempotency-Key", "request-key").contentType("application/json").content("{\"packageId\":\"starter\"}"))
                .andExpect(status().isCreated()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("Location", "/api/v1/billing/payment-orders/" + order))
                .andExpect(jsonPath("$.order.amountMinor").value(10_000))
                .andExpect(jsonPath("$.order.credits").value(1_000));
    }

    @Test
    void validatesPackageAndRequiresIdempotencyHeader() throws Exception {
        UUID owner = UUID.randomUUID();
        mvc.perform(post("/api/v1/billing/payment-orders").with(jwt().jwt(j -> j.subject(owner.toString())))
                        .header("Idempotency-Key", "key").contentType("application/json").content("{\"packageId\":\"\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/v1/billing/payment-orders").with(jwt().jwt(j -> j.subject(owner.toString())))
                        .contentType("application/json").content("{\"packageId\":\"starter\"}"))
                .andExpect(status().isBadRequest());
        then(application).shouldHaveNoInteractions();
    }

    @Test
    void anotherOwnersOrderDoesNotRevealExistence() throws Exception {
        UUID stranger = UUID.randomUUID(), order = UUID.randomUUID();
        given(transactions.order(stranger, order)).willThrow(new NotFoundException("PAYMENT_NOT_FOUND", "Payment order not found."));
        mvc.perform(get("/api/v1/billing/payment-orders/" + order).with(jwt().jwt(j -> j.subject(stranger.toString()))))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("PAYMENT_NOT_FOUND"));
    }

    @Test
    void providerGetIpnIsAnonymousAndRetainsDuplicateParameters() throws Exception {
        given(application.ipn(eq("sandbox-v1"), argThat(q -> q.get("vnp_Amount").size() == 2)))
                .willReturn(BillingResponses.Ipn.of("99"));
        mvc.perform(get("/api/v1/billing/vnpay/sandbox-v1/ipn").param("vnp_Amount", "1000000", "2000000")
                        .header("Authorization", "Bearer stale-browser-token"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.RspCode").value("99"))
                .andExpect(header().string("Cache-Control", "no-store"));
        then(decoder).shouldHaveNoInteractions();
    }

    @Test
    void noBroadAnonymousProviderApiOrReturnSettlement() throws Exception {
        mvc.perform(post("/api/v1/billing/vnpay/sandbox-v1/ipn")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/billing/vnpay/sandbox-v1/order")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/billing/return")).andExpect(status().isUnauthorized());
        then(application).shouldHaveNoInteractions();
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {
        @Bean CorsProperties corsProperties() { return new CorsProperties(List.of("http://localhost:5173")); }
    }
}
