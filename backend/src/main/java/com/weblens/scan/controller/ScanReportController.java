package com.weblens.scan.controller;

import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.common.config.OpenApiConfig;
import com.weblens.scan.dto.ScanPageResponse;
import com.weblens.scan.dto.ScanPagesResponse;
import com.weblens.scan.service.ScanReportService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Scan reports")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
@Validated
public class ScanReportController {

    private final ScanReportService reports;

    public ScanReportController(ScanReportService reports) {
        this.reports = reports;
    }

    @GetMapping("/scans/{scanId}/pages")
    @Operation(summary = "List bounded page outcomes for one scan")
    ScanPagesResponse listPages(
            @AuthenticationPrincipal Jwt jwt,
            @PathVariable UUID scanId,
            @RequestParam(defaultValue = "100") @Min(1) @Max(500) int limit,
            @RequestParam(required = false) String cursor
    ) {
        return reports.listPages(AuthenticatedUserId.from(jwt), scanId, limit, cursor);
    }

    @GetMapping("/scan-pages/{pageId}")
    @Operation(summary = "Get deterministic evidence for one crawled page")
    ScanPageResponse getPage(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID pageId) {
        return reports.getPage(AuthenticatedUserId.from(jwt), pageId);
    }
}
