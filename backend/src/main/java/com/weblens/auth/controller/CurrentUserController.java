package com.weblens.auth.controller;

import com.weblens.auth.dto.UserResponse;
import com.weblens.auth.security.AuthenticatedUserId;
import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.config.OpenApiConfig;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/me")
@Tag(name = "Current user")
@SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)
public class CurrentUserController {

    private final CurrentUserService currentUsers;

    public CurrentUserController(CurrentUserService currentUsers) {
        this.currentUsers = currentUsers;
    }

    @GetMapping
    @Operation(summary = "Get the authenticated user")
    UserResponse currentUser(@AuthenticationPrincipal Jwt jwt) {
        return currentUsers.getActiveUser(AuthenticatedUserId.from(jwt));
    }
}
