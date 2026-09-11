package com.weblens.common.exception;

import com.weblens.common.logging.CorrelationIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.Collection;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.stereotype.Component;

@Component
public class ProblemDetailsFactory {

    private static final String PROBLEM_BASE = "https://docs.weblens.dev/problems/";

    public ProblemDetail create(
            HttpStatus status,
            String code,
            String title,
            String detail,
            HttpServletRequest request
    ) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setType(URI.create(PROBLEM_BASE + code.toLowerCase().replace('_', '-')));
        problem.setTitle(title);
        problem.setInstance(URI.create(request.getRequestURI()));
        problem.setProperty("code", code);
        problem.setProperty("correlationId", CorrelationIdFilter.getCorrelationId(request));
        return problem;
    }

    public ProblemDetail validation(
            Collection<?> fieldErrors,
            HttpServletRequest request
    ) {
        ProblemDetail problem = create(
                HttpStatus.BAD_REQUEST,
                "VALIDATION_FAILED",
                "Request validation failed",
                "One or more fields are invalid.",
                request
        );
        problem.setProperty("fieldErrors", fieldErrors);
        return problem;
    }
}
