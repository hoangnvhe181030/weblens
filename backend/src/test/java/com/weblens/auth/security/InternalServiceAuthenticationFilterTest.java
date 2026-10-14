package com.weblens.auth.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class InternalServiceAuthenticationFilterTest {

    @Test
    void metricsRequireServiceTokenIncludingWhenUserBearerTokenIsPresent() throws Exception {
        var filter = new InternalServiceAuthenticationFilter("test-service-token-at-least-32-bytes",
                new ProblemDetailsFactory(), new ProblemResponseWriter(new ObjectMapper()));
        for (String path : new String[]{"/actuator/metrics", "/actuator/metrics/jvm.memory.used"}) {
            for (String token : new String[]{"", "wrong", "test-service-token-at-least-32-bytes"}) {
                var request = new MockHttpServletRequest("GET", path);
                request.addHeader("Authorization", "Bearer user-token");
                if (!token.isEmpty()) request.addHeader("X-WebLens-Service-Token", token);
                var response = new MockHttpServletResponse();
                var invoked = new AtomicBoolean();
                filter.doFilter(request, response, (req, res) -> invoked.set(true));
                boolean valid = token.equals("test-service-token-at-least-32-bytes");
                assertThat(invoked.get()).isEqualTo(valid);
                assertThat(response.getStatus()).isEqualTo(valid ? 200 : 401);
            }
        }
    }
}
