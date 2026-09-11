package com.weblens.auth.security;

import java.security.SecureRandom;
import java.util.Base64;
import org.springframework.stereotype.Component;

@Component
public class RandomTokenService {

    private final SecureRandom secureRandom;

    public RandomTokenService(SecureRandom secureRandom) {
        this.secureRandom = secureRandom;
    }

    public String create() {
        byte[] bytes = new byte[32];
        secureRandom.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
