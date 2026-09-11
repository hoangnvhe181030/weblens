package com.weblens.auth.controller;

import static org.mockito.BDDMockito.given;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.weblens.auth.dto.UserResponse;
import com.weblens.auth.model.UserStatus;
import com.weblens.auth.security.DoubleSubmitCsrfFilter;
import com.weblens.auth.security.ProblemAccessDeniedHandler;
import com.weblens.auth.security.ProblemAuthenticationEntryPoint;
import com.weblens.auth.security.SecurityConfig;
import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.config.CorsProperties;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import com.weblens.common.logging.CorrelationIdFilter;
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

@WebMvcTest(CurrentUserController.class)
@Import({
        SecurityConfig.class,
        DoubleSubmitCsrfFilter.class,
        ProblemAuthenticationEntryPoint.class,
        ProblemAccessDeniedHandler.class,
        ProblemDetailsFactory.class,
        ProblemResponseWriter.class,
        CorrelationIdFilter.class,
        CurrentUserSecurityTest.TestBeans.class
})
class CurrentUserSecurityTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private CurrentUserService currentUsers;

    @MockitoBean
    private JwtDecoder jwtDecoder;

    @Test
    void protectedEndpointReturnsProblemDetailWithoutBearerToken() throws Exception {
        mvc.perform(get("/api/v1/me").header(CorrelationIdFilter.HEADER, "security-test"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string(CorrelationIdFilter.HEADER, "security-test"))
                .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))
                .andExpect(jsonPath("$.correlationId").value("security-test"));
    }

    @Test
    void authenticatedJwtSubjectReachesCurrentUserUseCase() throws Exception {
        UUID userId = UUID.randomUUID();
        given(currentUsers.getActiveUser(userId)).willReturn(new UserResponse(
                userId,
                "developer@example.com",
                "Developer",
                UserStatus.ACTIVE
        ));

        mvc.perform(get("/api/v1/me").with(jwt().jwt(token -> token.subject(userId.toString()))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(userId.toString()))
                .andExpect(jsonPath("$.status").value("ACTIVE"));
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {

        @Bean
        CorsProperties corsProperties() {
            return new CorsProperties(List.of("http://localhost:5173"));
        }
    }
}
