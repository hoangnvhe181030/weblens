package com.weblens.common.logging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class CorrelationIdFilterTest {
    @Test
    void admissionEntryAndFailureAreVisibleWithoutLoggingCredentialsOrBody() {
        Logger logger = (Logger) LoggerFactory.getLogger("com.weblens.scan.admission.http");
        var output = new ListAppender<ILoggingEvent>();
        output.start();
        logger.addAppender(output);
        try {
            var request = new MockHttpServletRequest("POST", "/api/v1/websites/11111111-1111-1111-1111-111111111111/scans");
            request.addHeader("X-Correlation-ID", "admission-probe-1");
            request.addHeader("Authorization", "Bearer private-token");
            request.setContent("private-body".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertThatThrownBy(() -> new CorrelationIdFilter().doFilter(request, new MockHttpServletResponse(),
                    (req, res) -> { throw new ServletException("private-provider-error"); }))
                    .isInstanceOf(ServletException.class);
            assertThat(output.list).hasSize(2);
            assertThat(output.list.getFirst().getFormattedMessage()).contains("scan_admission_enter", "admission-probe-1");
            assertThat(output.list.getLast().getFormattedMessage()).contains("completed=false", "elapsedMs=");
            assertThat(output.list.stream().map(ILoggingEvent::getFormattedMessage).toList())
                    .allSatisfy(line -> assertThat(line).doesNotContain("private-token", "private-body", "private-provider-error"));
        } finally { logger.detachAppender(output); output.stop(); }
    }
}
