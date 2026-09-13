package com.weblens.capture.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.common.config.CaptureProperties;
import com.weblens.common.exception.ApiException;
import java.net.URI;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

class CaptureReportClientTest {

    private static final String TOKEN = "capture-report-test-token-at-least-32-bytes";

    @Test
    void downloadsResourceAsBoundedOctetStream() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        CaptureReportClient client = new CaptureReportClient(
                builder.baseUrl(properties().reportBaseUrl().toString()).build(),
                properties()
        );
        UUID ownerId = UUID.randomUUID();
        UUID captureId = UUID.randomUUID();
        UUID resourceId = UUID.randomUUID();
        byte[] evidence = "untrusted-script".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        server.expect(requestTo(
                        "http://capture-worker.test/internal/v1/reports/captures/%s/resources/%s/content?ownerId=%s"
                                .formatted(captureId, resourceId, ownerId)
                ))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("X-WebLens-Service-Token", TOKEN))
                .andRespond(withSuccess(evidence, MediaType.APPLICATION_OCTET_STREAM)
                        .header("ETag", "\"sha256-resource\""));

        CaptureArtifactContent artifact = client.getResourceBody(ownerId, captureId, resourceId);

        assertThat(artifact.bytes()).isEqualTo(evidence);
        assertThat(artifact.contentType()).isEqualTo(MediaType.APPLICATION_OCTET_STREAM_VALUE);
        assertThat(artifact.etag()).isEqualTo("\"sha256-resource\"");
        server.verify();
    }

    @Test
    void mapsExpiredArtifactToStableGoneError() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        CaptureReportClient client = new CaptureReportClient(
                builder.baseUrl(properties().reportBaseUrl().toString()).build(),
                properties()
        );
        UUID ownerId = UUID.randomUUID();
        UUID captureId = UUID.randomUUID();
        UUID resourceId = UUID.randomUUID();
        server.expect(requestTo(
                        "http://capture-worker.test/internal/v1/reports/captures/%s/resources/%s/content?ownerId=%s"
                                .formatted(captureId, resourceId, ownerId)
                ))
                .andRespond(withStatus(HttpStatus.GONE)
                        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                        .body("{\"code\":\"CAPTURE_ARTIFACT_GONE\"}"));

        assertThatThrownBy(() -> client.getResourceBody(ownerId, captureId, resourceId))
                .isInstanceOfSatisfying(ApiException.class, exception -> {
                    assertThat(exception.status()).isEqualTo(HttpStatus.GONE);
                    assertThat(exception.code()).isEqualTo("CAPTURE_ARTIFACT_GONE");
                });
        server.verify();
    }

    @Test
    void preservesIntegrityFailureFromCaptureWorker() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        CaptureReportClient client = new CaptureReportClient(
                builder.baseUrl(properties().reportBaseUrl().toString()).build(),
                properties()
        );
        UUID ownerId = UUID.randomUUID();
        UUID captureId = UUID.randomUUID();
        UUID resourceId = UUID.randomUUID();
        server.expect(requestTo(
                        "http://capture-worker.test/internal/v1/reports/captures/%s/resources/%s/content?ownerId=%s"
                                .formatted(captureId, resourceId, ownerId)
                ))
                .andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE)
                        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                        .body("{\"code\":\"CAPTURE_ARTIFACT_INTEGRITY_FAILED\"}"));

        assertThatThrownBy(() -> client.getResourceBody(ownerId, captureId, resourceId))
                .isInstanceOfSatisfying(ApiException.class, exception -> {
                    assertThat(exception.status()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(exception.code()).isEqualTo("CAPTURE_ARTIFACT_INTEGRITY_FAILED");
                });
        server.verify();
    }

    private static CaptureProperties properties() {
        return new CaptureProperties(
                URI.create("http://capture-worker.test/internal/v1/commands/captures"),
                URI.create("http://capture-worker.test"),
                TOKEN,
                Duration.ofSeconds(1),
                Duration.ofSeconds(5),
                Duration.ofSeconds(30)
        );
    }
}
