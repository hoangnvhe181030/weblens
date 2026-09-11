package com.weblens.scan.client;

import java.util.List;

public record CrawlerScanPagesContract(
        CrawlerReportStateContract state,
        List<CrawlerPageContract> items
) {
}
