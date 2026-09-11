package com.weblens.auth.security;

import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;

@Component
public class ProblemAccessDeniedHandler implements AccessDeniedHandler {

    private final ProblemDetailsFactory problems;
    private final ProblemResponseWriter writer;

    public ProblemAccessDeniedHandler(ProblemDetailsFactory problems, ProblemResponseWriter writer) {
        this.problems = problems;
        this.writer = writer;
    }

    @Override
    public void handle(
            HttpServletRequest request,
            HttpServletResponse response,
            AccessDeniedException accessDeniedException
    ) throws IOException {
        writer.write(response, problems.create(
                HttpStatus.FORBIDDEN,
                "ACCESS_DENIED",
                "Access denied",
                "The current user is not allowed to perform this operation.",
                request
        ));
    }
}
