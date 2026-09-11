package com.weblens.auth.dto;

import com.weblens.auth.model.UserStatus;
import java.util.UUID;

public record UserResponse(UUID id, String email, String displayName, UserStatus status) {
}
