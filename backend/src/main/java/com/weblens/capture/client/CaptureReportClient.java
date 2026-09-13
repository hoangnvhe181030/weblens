package com.weblens.capture.client;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.capture.dto.CaptureSnapshotResponse;
import com.weblens.common.config.CaptureProperties;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class CaptureReportClient {

    private static final int MAX_SCREENSHOT_BYTES = 52_428_800;

    private final RestClient client;
    private final CaptureProperties properties;

    public CaptureReportClient(RestClient.Builder builder, CaptureProperties properties) {
        this.properties = properties;
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        this.client = builder.clone()
                .baseUrl(properties.reportBaseUrl().toString())
                .requestFactory(requestFactory)
                .build();
    }

    public CaptureSnapshotResponse getSnapshot(UUID ownerId, UUID captureId) {
        return client.get()
                .uri(uri -> uri.path("/internal/v1/reports/captures/{captureId}")
                        .queryParam("ownerId", ownerId)
                        .build(captureId))
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .body(CaptureSnapshotResponse.class);
    }

    public CaptureArtifactContent getScreenshot(UUID ownerId, UUID captureId) {
        ResponseEntity<byte[]> response = client.get()
                .uri(uri -> uri.path("/internal/v1/reports/captures/{captureId}/artifacts/screenshot")
                        .queryParam("ownerId", ownerId)
                        .build(captureId))
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .toEntity(byte[].class);
        byte[] body = response.getBody();
        if (body == null || body.length == 0 || body.length > MAX_SCREENSHOT_BYTES) {
            throw new IllegalStateException("Capture Worker returned an invalid screenshot payload.");
        }
        MediaType contentType = response.getHeaders().getContentType();
        if (!MediaType.IMAGE_JPEG.equals(contentType)) {
            throw new IllegalStateException("Capture Worker returned an unexpected screenshot content type.");
        }
        return new CaptureArtifactContent(
                body,
                MediaType.IMAGE_JPEG_VALUE,
                response.getHeaders().getFirst(HttpHeaders.ETAG)
        );
    }
}
