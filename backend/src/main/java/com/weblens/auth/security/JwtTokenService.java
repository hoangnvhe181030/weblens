package com.weblens.auth.security;

import com.weblens.common.config.JwtProperties;
import com.weblens.common.exception.UnauthorizedException;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.stereotype.Service;

@Service
public class JwtTokenService {

    public static final String TOKEN_TYPE = "token_type";
    public static final String SESSION_ID = "sid";

    private final JwtEncoder encoder;
    private final JwtDecoder refreshDecoder;
    private final JwtProperties properties;
    private final Clock clock;

    public JwtTokenService(
            JwtEncoder encoder,
            @Qualifier("refreshJwtDecoder") JwtDecoder refreshDecoder,
            JwtProperties properties,
            Clock clock
    ) {
        this.encoder = encoder;
        this.refreshDecoder = refreshDecoder;
        this.properties = properties;
        this.clock = clock;
    }

    public TokenPair issue(UUID userId, UUID sessionId) {
        Instant issuedAt = clock.instant();
        Instant accessExpiresAt = issuedAt.plus(properties.accessTtl());
        Instant refreshExpiresAt = issuedAt.plus(properties.refreshTtl());
        String accessJti = UUID.randomUUID().toString();
        String refreshJti = UUID.randomUUID().toString();

        String access = encode(userId, sessionId, accessJti, "access", issuedAt, accessExpiresAt);
        String refresh = encode(userId, sessionId, refreshJti, "refresh", issuedAt, refreshExpiresAt);
        return new TokenPair(access, accessExpiresAt, refresh, refreshJti, refreshExpiresAt);
    }

    public Jwt decodeRefresh(String token) {
        try {
            return refreshDecoder.decode(token);
        } catch (JwtException | IllegalArgumentException exception) {
            throw new UnauthorizedException("INVALID_REFRESH_TOKEN", "The refresh credential is invalid or expired.");
        }
    }

    private String encode(
            UUID userId,
            UUID sessionId,
            String tokenId,
            String tokenType,
            Instant issuedAt,
            Instant expiresAt
    ) {
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(properties.issuer())
                .audience(java.util.List.of(properties.audience()))
                .subject(userId.toString())
                .issuedAt(issuedAt)
                .notBefore(issuedAt)
                .expiresAt(expiresAt)
                .id(tokenId)
                .claim(SESSION_ID, sessionId.toString())
                .claim(TOKEN_TYPE, tokenType)
                .build();
        JwsHeader header = JwsHeader.with(MacAlgorithm.HS256).type("JWT").build();
        return encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
    }
}
