package com.weblens.common.exception;

import com.weblens.common.dto.FieldErrorResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import java.util.Comparator;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestCookieException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private final ProblemDetailsFactory problems;

    public GlobalExceptionHandler(ProblemDetailsFactory problems) {
        this.problems = problems;
    }

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ProblemDetail> handleApi(ApiException exception, HttpServletRequest request) {
        return response(exception.status(), problems.create(
                exception.status(),
                exception.code(),
                exception.title(),
                exception.getMessage(),
                request
        ));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ProblemDetail> handleBodyValidation(
            MethodArgumentNotValidException exception,
            HttpServletRequest request
    ) {
        List<FieldErrorResponse> errors = exception.getBindingResult().getFieldErrors().stream()
                .map(error -> new FieldErrorResponse(
                        error.getField(),
                        error.getDefaultMessage() == null ? "Invalid value" : error.getDefaultMessage()
                ))
                .sorted(Comparator.comparing(FieldErrorResponse::field))
                .toList();
        return response(HttpStatus.BAD_REQUEST, problems.validation(errors, request));
    }

    @ExceptionHandler({ConstraintViolationException.class, HandlerMethodValidationException.class, BindException.class})
    ResponseEntity<ProblemDetail> handleParameterValidation(Exception exception, HttpServletRequest request) {
        return response(HttpStatus.BAD_REQUEST, problems.validation(List.of(), request));
    }

    @ExceptionHandler({
            HttpMessageNotReadableException.class,
            MethodArgumentTypeMismatchException.class,
            MissingRequestHeaderException.class,
            MissingRequestCookieException.class
    })
    ResponseEntity<ProblemDetail> handleMalformedRequest(Exception exception, HttpServletRequest request) {
        return response(HttpStatus.BAD_REQUEST, problems.create(
                HttpStatus.BAD_REQUEST,
                "MALFORMED_REQUEST",
                "Malformed request",
                "The request could not be parsed.",
                request
        ));
    }

    @ExceptionHandler(OptimisticLockingFailureException.class)
    ResponseEntity<ProblemDetail> handleOptimisticLock(
            OptimisticLockingFailureException exception,
            HttpServletRequest request
    ) {
        return response(HttpStatus.CONFLICT, problems.create(
                HttpStatus.CONFLICT,
                "CONCURRENT_MODIFICATION",
                "Concurrent modification",
                "The resource changed while the request was being processed. Retry with fresh data.",
                request
        ));
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<ProblemDetail> handleIntegrity(DataIntegrityViolationException exception, HttpServletRequest request) {
        log.warn("Database constraint rejected a request");
        return response(HttpStatus.CONFLICT, problems.create(
                HttpStatus.CONFLICT,
                "DATA_CONFLICT",
                "Data conflict",
                "The request conflicts with existing data.",
                request
        ));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> handleUnexpected(Exception exception, HttpServletRequest request) {
        log.error("Unhandled request failure", exception);
        return response(HttpStatus.INTERNAL_SERVER_ERROR, problems.create(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "Internal server error",
                "The request could not be completed.",
                request
        ));
    }

    private ResponseEntity<ProblemDetail> response(HttpStatus status, ProblemDetail problem) {
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(problem);
    }
}
