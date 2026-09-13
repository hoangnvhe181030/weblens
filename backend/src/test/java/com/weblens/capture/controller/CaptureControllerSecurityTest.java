package com.weblens.capture.controller;

import static org.mockito.BDDMockito.given;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.weblens.auth.security.DoubleSubmitCsrfFilter;
import com.weblens.auth.security.ProblemAccessDeniedHandler;
import com.weblens.auth.security.ProblemAuthenticationEntryPoint;
import com.weblens.auth.security.SecurityConfig;
import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.capture.dto.CaptureResponse;
import com.weblens.capture.model.CaptureStatus;
import com.weblens.capture.service.CaptureService;
import com.weblens.common.config.CorsProperties;
import com.weblens.common.exception.GlobalExceptionHandler;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import com.weblens.common.logging.CorrelationIdFilter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(CaptureController.class)
@Import({
        SecurityConfig.class,
        DoubleSubmitCsrfFilter.class,
        ProblemAuthenticationEntryPoint.class,
        ProblemAccessDeniedHandler.class,
        ProblemDetailsFactory.class,
        ProblemResponseWriter.class,
        GlobalExceptionHandler.class,
        CorrelationIdFilter.class,
        CaptureControllerSecurityTest.TestBeans.class
})
class CaptureControllerSecurityTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private CaptureService captures;

    @MockitoBean
    private JwtDecoder jwtDecoder;

    @Test
    void screenshotRequiresUserAuthentication() throws Exception {
        mvc.perform(get("/api/v1/captures/{captureId}/artifacts/screenshot", UUID.randomUUID()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void screenshotIsReturnedWithoutStorageCredentials() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID captureId = UUID.randomUUID();
        byte[] jpeg = "jpeg-evidence".getBytes(StandardCharsets.UTF_8);
        given(captures.getScreenshot(userId, captureId))
                .willReturn(new CaptureArtifactContent(jpeg, MediaType.IMAGE_JPEG_VALUE, "\"sha256-test\""));

        mvc.perform(get("/api/v1/captures/{captureId}/artifacts/screenshot", captureId)
                        .with(jwt().jwt(token -> token.subject(userId.toString()))))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_JPEG))
                .andExpect(content().bytes(jpeg))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(header().string(HttpHeaders.ETAG, "\"sha256-test\""))
                .andExpect(header().doesNotExist("X-WebLens-Service-Token"));
    }

    @Test
    void latestReadyCaptureRequiresUserAuthentication() throws Exception {
        mvc.perform(get(
                        "/api/v1/scans/{scanId}/scan-pages/{pageId}/captures/latest-ready",
                        UUID.randomUUID(),
                        UUID.randomUUID()
                ))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void latestReadyCaptureIsOwnerScopedAndReturnsNoContentWhenAbsent() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID scanId = UUID.randomUUID();
        UUID pageId = UUID.randomUUID();
        given(captures.getLatestReady(userId, scanId, pageId)).willReturn(Optional.empty());

        mvc.perform(get(
                        "/api/v1/scans/{scanId}/scan-pages/{pageId}/captures/latest-ready",
                        scanId,
                        pageId
                ).with(jwt().jwt(token -> token.subject(userId.toString()))))
                .andExpect(status().isNoContent());
    }

    @Test
    void latestReadyCaptureReturnsTheAuthorizedProjection() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID scanId = UUID.randomUUID();
        UUID pageId = UUID.randomUUID();
        UUID captureId = UUID.randomUUID();
        Instant now = Instant.parse("2026-09-13T06:00:00Z");
        CaptureResponse response = new CaptureResponse(
                captureId, scanId, pageId, CaptureStatus.COMPLETED,
                "https://example.com/", "desktop-lab-v1",
                1, 1, 2, 17_739, null, null, now, now, now
        );
        given(captures.getLatestReady(userId, scanId, pageId)).willReturn(Optional.of(response));

        mvc.perform(get(
                        "/api/v1/scans/{scanId}/scan-pages/{pageId}/captures/latest-ready",
                        scanId,
                        pageId
                ).with(jwt().jwt(token -> token.subject(userId.toString()))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(captureId.toString()))
                .andExpect(jsonPath("$.scanId").value(scanId.toString()))
                .andExpect(jsonPath("$.pageId").value(pageId.toString()))
                .andExpect(jsonPath("$.status").value("COMPLETED"));
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {

        @Bean
        CorsProperties corsProperties() {
            return new CorsProperties(List.of("http://localhost:5173"));
        }
    }
}
