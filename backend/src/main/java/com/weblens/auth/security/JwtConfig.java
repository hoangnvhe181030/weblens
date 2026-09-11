package com.weblens.auth.security;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.nimbusds.jose.proc.SecurityContext;
import com.weblens.common.config.JwtProperties;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

@Configuration(proxyBeanMethods = false)
public class JwtConfig {

    @Bean
    SecretKey jwtSecretKey(JwtProperties properties) {
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(properties.secret());
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException("WEBLENS_JWT_SECRET must be valid Base64", exception);
        }
        if (decoded.length < 32) {
            throw new IllegalStateException("WEBLENS_JWT_SECRET must decode to at least 32 bytes");
        }
        return new SecretKeySpec(decoded, "HmacSHA256");
    }

    @Bean
    JwtEncoder jwtEncoder(SecretKey jwtSecretKey) {
        return new NimbusJwtEncoder(new ImmutableSecret<SecurityContext>(jwtSecretKey));
    }

    @Bean
    @Primary
    JwtDecoder jwtDecoder(SecretKey jwtSecretKey, JwtProperties properties) {
        return decoder(jwtSecretKey, properties, "access");
    }

    @Bean("refreshJwtDecoder")
    JwtDecoder refreshJwtDecoder(SecretKey jwtSecretKey, JwtProperties properties) {
        return decoder(jwtSecretKey, properties, "refresh");
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        Map<String, PasswordEncoder> encoders = new HashMap<>();
        encoders.put("bcrypt", new BCryptPasswordEncoder(12));
        return new DelegatingPasswordEncoder("bcrypt", encoders);
    }

    private JwtDecoder decoder(SecretKey secretKey, JwtProperties properties, String expectedType) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(secretKey)
                .macAlgorithm(MacAlgorithm.HS256)
                .build();
        OAuth2TokenValidator<Jwt> defaults = JwtValidators.createDefaultWithIssuer(properties.issuer());
        OAuth2TokenValidator<Jwt> audience = jwt -> jwt.getAudience().contains(properties.audience())
                ? OAuth2TokenValidatorResult.success()
                : failure("JWT audience is invalid");
        OAuth2TokenValidator<Jwt> tokenType = jwt -> expectedType.equals(jwt.getClaimAsString(JwtTokenService.TOKEN_TYPE))
                ? OAuth2TokenValidatorResult.success()
                : failure("JWT token type is invalid");
        OAuth2TokenValidator<Jwt> requiredClaims = jwt -> hasRequiredClaims(jwt)
                ? OAuth2TokenValidatorResult.success()
                : failure("JWT required claims are invalid");
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                defaults,
                audience,
                tokenType,
                requiredClaims
        ));
        return decoder;
    }

    private boolean hasRequiredClaims(Jwt jwt) {
        try {
            if (jwt.getId() == null || jwt.getId().isBlank()
                    || jwt.getSubject() == null || jwt.getIssuedAt() == null
                    || jwt.getExpiresAt() == null || jwt.getClaimAsInstant("nbf") == null) {
                return false;
            }
            UUID.fromString(jwt.getSubject());
            UUID.fromString(jwt.getClaimAsString(JwtTokenService.SESSION_ID));
            return true;
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private OAuth2TokenValidatorResult failure(String description) {
        return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", description, null));
    }
}
