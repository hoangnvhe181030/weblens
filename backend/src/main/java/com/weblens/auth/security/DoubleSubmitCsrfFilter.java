package com.weblens.auth.security;

import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class DoubleSubmitCsrfFilter extends OncePerRequestFilter {

    private static final String REFRESH_PATH = "/api/v1/auth/token-refreshes";
    private static final String LOGOUT_PATH = "/api/v1/auth/session";

    private final ProblemDetailsFactory problems;
    private final ProblemResponseWriter writer;

    public DoubleSubmitCsrfFilter(ProblemDetailsFactory problems, ProblemResponseWriter writer) {
        this.problems = problems;
        this.writer = writer;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        boolean refresh = "POST".equals(request.getMethod()) && REFRESH_PATH.equals(request.getRequestURI());
        boolean logout = "DELETE".equals(request.getMethod()) && LOGOUT_PATH.equals(request.getRequestURI());
        return !refresh && !logout;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        String refreshCookie = cookie(request, AuthCookieFactory.REFRESH_COOKIE);
        if (refreshCookie == null && "DELETE".equals(request.getMethod())) {
            filterChain.doFilter(request, response);
            return;
        }

        String csrfCookie = cookie(request, AuthCookieFactory.CSRF_COOKIE);
        String csrfHeader = request.getHeader(AuthCookieFactory.CSRF_HEADER);
        if (csrfCookie == null || csrfHeader == null || !constantTimeEquals(csrfCookie, csrfHeader)) {
            writer.write(response, problems.create(
                    HttpStatus.FORBIDDEN,
                    "CSRF_VALIDATION_FAILED",
                    "CSRF validation failed",
                    "The CSRF token is missing or invalid.",
                    request
            ));
            return;
        }
        filterChain.doFilter(request, response);
    }

    private String cookie(HttpServletRequest request, String name) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        return Arrays.stream(cookies)
                .filter(cookie -> name.equals(cookie.getName()))
                .map(Cookie::getValue)
                .findFirst()
                .orElse(null);
    }

    private boolean constantTimeEquals(String left, String right) {
        return MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8),
                right.getBytes(StandardCharsets.UTF_8)
        );
    }
}
