package com.weblens.scan.client;

import com.weblens.common.config.CrawlerProperties;
import java.util.UUID;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class CrawlerReportClient {

    private final RestClient client;
    private final CrawlerProperties properties;

    public CrawlerReportClient(
            RestClient.Builder builder,
            CrawlerProperties properties
    ) {
        this.properties = properties;
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.connectTimeout());
        requestFactory.setReadTimeout(properties.readTimeout());
        this.client = builder.clone()
                .baseUrl(properties.reportBaseUrl().toString())
                .requestFactory(requestFactory)
                .build();
    }

    public CrawlerScanPagesContract listPages(UUID ownerId, UUID scanId, int limit, String cursor) {
        return client.get()
                .uri(uri -> uri.path("/internal/v1/reports/scans/{scanId}/pages")
                        .queryParam("ownerId", ownerId)
                        .queryParam("limit", limit)
                        .queryParamIfPresent("cursor", java.util.Optional.ofNullable(cursor))
                        .build(scanId))
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .body(CrawlerScanPagesContract.class);
    }

    public CrawlerPageContract getPage(UUID ownerId, UUID pageId) {
        return client.get()
                .uri(uri -> uri.path("/internal/v1/reports/pages/{pageId}")
                        .queryParam("ownerId", ownerId)
                        .build(pageId))
                .header("X-WebLens-Service-Token", properties.serviceToken())
                .retrieve()
                .body(CrawlerPageContract.class);
    }
}
