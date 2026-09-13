package com.weblens.scan.client;

import java.util.List;

public record CrawlerScanPagesContract(
        CrawlerReportStateContract state,
        List<CrawlerPageContract> items,
        String nextCursor
) {
    public CrawlerScanPagesContract(CrawlerReportStateContract state, List<CrawlerPageContract> items) {
        this(state, items, null);
    }
}
