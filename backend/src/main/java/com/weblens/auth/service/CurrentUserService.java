package com.weblens.auth.service;

import com.weblens.auth.dto.UserResponse;
import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.auth.repository.UserRepository;
import com.weblens.common.exception.UnauthorizedException;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class CurrentUserService {

    private final UserRepository users;

    public CurrentUserService(UserRepository users) {
        this.users = users;
    }

    public UserResponse getActiveUser(UUID userId) {
        return toResponse(requireActiveUser(userId));
    }

    public void requireActive(UUID userId) {
        requireActiveUser(userId);
    }

    @Transactional
    public void lockActive(UUID userId) {
        UserEntity user = users.findByIdForUpdate(userId).orElseThrow(() -> invalidUser());
        if (user.getStatus() != UserStatus.ACTIVE) {
            throw invalidUser();
        }
    }

    UserEntity requireActiveUser(UUID userId) {
        UserEntity user = users.findById(userId)
                .orElseThrow(() -> invalidUser());
        if (user.getStatus() != UserStatus.ACTIVE) {
            throw invalidUser();
        }
        return user;
    }

    static UserResponse toResponse(UserEntity user) {
        return new UserResponse(user.getId(), user.getEmail(), user.getDisplayName(), user.getStatus());
    }

    private UnauthorizedException invalidUser() {
        return new UnauthorizedException("INVALID_USER", "The authenticated user is unavailable.");
    }
}
