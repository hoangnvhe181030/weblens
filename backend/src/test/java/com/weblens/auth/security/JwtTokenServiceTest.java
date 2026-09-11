package com.weblens.auth.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.common.config.JwtProperties;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.SecretKey;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

class JwtTokenServiceTest {

    private static final String SECRET = "d2VibGVucy10ZXN0LW9ubHktc2VjcmV0LWlzLWF0LWxlYXN0LTMyLWJ5dGVz";
    @Test
    void issuesSignedAccessAndRefreshTokensWithRequiredClaims() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        JwtProperties properties = properties();
        JwtConfig config = new JwtConfig();
        SecretKey key = config.jwtSecretKey(properties);
        JwtDecoder accessDecoder = config.jwtDecoder(key, properties);
        JwtDecoder refreshDecoder = config.refreshJwtDecoder(key, properties);
        JwtTokenService service = new JwtTokenService(
                config.jwtEncoder(key),
                refreshDecoder,
                properties,
                Clock.fixed(now, ZoneOffset.UTC)
        );
        UUID userId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();

        TokenPair pair = service.issue(userId, sessionId);
        Jwt access = accessDecoder.decode(pair.accessToken());
        Jwt refresh = service.decodeRefresh(pair.refreshToken());

        assertThat(access.getSubject()).isEqualTo(userId.toString());
        assertThat(access.getClaimAsString(JwtTokenService.SESSION_ID)).isEqualTo(sessionId.toString());
        assertThat(access.getClaimAsString(JwtTokenService.TOKEN_TYPE)).isEqualTo("access");
        assertThat(access.getAudience()).containsExactly("weblens-web-test");
        assertThat(access.getExpiresAt()).isEqualTo(now.plus(Duration.ofMinutes(15)));
        assertThat(refresh.getClaimAsString(JwtTokenService.TOKEN_TYPE)).isEqualTo("refresh");
        assertThat(refresh.getId()).isEqualTo(pair.refreshJti());
        assertThatThrownBy(() -> accessDecoder.decode(pair.refreshToken())).isInstanceOf(JwtException.class);

        JwtProperties wrongAudience = new JwtProperties(
                SECRET,
                properties.issuer(),
                "another-audience",
                properties.accessTtl(),
                properties.refreshTtl()
        );
        assertThatThrownBy(() -> config.jwtDecoder(key, wrongAudience).decode(pair.accessToken()))
                .isInstanceOf(JwtException.class);

        String anotherSecret = Base64.getEncoder().encodeToString(
                "a-different-test-only-secret-with-more-than-32-bytes".getBytes(StandardCharsets.UTF_8)
        );
        JwtProperties wrongSignature = new JwtProperties(
                anotherSecret,
                properties.issuer(),
                properties.audience(),
                properties.accessTtl(),
                properties.refreshTtl()
        );
        SecretKey anotherKey = config.jwtSecretKey(wrongSignature);
        assertThatThrownBy(() -> config.jwtDecoder(anotherKey, wrongSignature).decode(pair.accessToken()))
                .isInstanceOf(JwtException.class);
    }

    private JwtProperties properties() {
        return new JwtProperties(
                SECRET,
                "weblens-api-test",
                "weblens-web-test",
                Duration.ofMinutes(15),
                Duration.ofDays(7)
        );
    }
}
