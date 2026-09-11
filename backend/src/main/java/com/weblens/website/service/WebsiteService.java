package com.weblens.website.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.exception.ConflictException;
import com.weblens.website.dto.CreateWebsiteRequest;
import com.weblens.website.dto.LatestScanResponse;
import com.weblens.website.dto.UpdateWebsiteRequest;
import com.weblens.website.dto.WebsiteResponse;
import com.weblens.website.entity.WebsiteEntity;
import com.weblens.website.model.WebsiteStatus;
import com.weblens.website.model.InvalidWebsiteTargetException;
import com.weblens.website.model.WebsiteTarget;
import com.weblens.website.repository.WebsiteRepository;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class WebsiteService {

    private static final int MAX_PAGE_SIZE = 100;

    private final WebsiteRepository websites;
    private final WebsiteScanLookup scans;
    private final CurrentUserService currentUsers;
    private final Clock clock;

    public WebsiteService(
            WebsiteRepository websites,
            WebsiteScanLookup scans,
            CurrentUserService currentUsers,
            Clock clock
    ) {
        this.websites = websites;
        this.scans = scans;
        this.currentUsers = currentUsers;
        this.clock = clock;
    }

    @Transactional
    public WebsiteResponse create(UUID ownerId, CreateWebsiteRequest request) {
        currentUsers.requireActive(ownerId);
        WebsiteTarget target = parseTarget(request.url());
        if (websites.existsByOwnerIdAndCanonicalUrlAndStatus(ownerId, target.canonicalUrl(), WebsiteStatus.ACTIVE)) {
            throw duplicateWebsite();
        }
        Instant now = clock.instant();
        WebsiteEntity website = new WebsiteEntity(
                UUID.randomUUID(),
                ownerId,
                request.name().strip(),
                target.canonicalUrl(),
                target.hostname(),
                now
        );
        try {
            websites.saveAndFlush(website);
        } catch (DataIntegrityViolationException exception) {
            throw duplicateWebsite();
        }
        return toResponse(website, null);
    }

    public PageResponse<WebsiteResponse> list(
            UUID ownerId,
            int page,
            int size,
            WebsiteStatus status,
            String sort
    ) {
        currentUsers.requireActive(ownerId);
        PageRequest pageable = PageRequest.of(page, boundedSize(size), parseSort(sort));
        Page<WebsiteEntity> result = websites.findAllByOwnerIdAndStatus(ownerId, status, pageable);
        Map<UUID, WebsiteScanLookup.LatestScanSummary> latest = scans.findLatest(
                ownerId,
                result.getContent().stream().map(WebsiteEntity::getId).toList()
        );
        return PageResponse.from(result.map(website -> toResponse(website, latest.get(website.getId()))));
    }

    public WebsiteResponse get(UUID ownerId, UUID websiteId) {
        currentUsers.requireActive(ownerId);
        WebsiteEntity website = websites.findByIdAndOwnerId(websiteId, ownerId)
                .orElseThrow(WebsiteAccessService::notFound);
        WebsiteScanLookup.LatestScanSummary latest = scans.findLatest(ownerId, List.of(websiteId)).get(websiteId);
        return toResponse(website, latest);
    }

    @Transactional
    public WebsiteResponse rename(UUID ownerId, UUID websiteId, UpdateWebsiteRequest request) {
        currentUsers.requireActive(ownerId);
        WebsiteEntity website = websites.findByIdAndOwnerId(websiteId, ownerId)
                .orElseThrow(WebsiteAccessService::notFound);
        website.rename(request.name().strip(), clock.instant());
        WebsiteScanLookup.LatestScanSummary latest = scans.findLatest(ownerId, List.of(websiteId)).get(websiteId);
        return toResponse(website, latest);
    }

    @Transactional
    public void archive(UUID ownerId, UUID websiteId) {
        currentUsers.requireActive(ownerId);
        WebsiteEntity website = websites.findForUpdate(websiteId, ownerId, WebsiteStatus.ACTIVE)
                .orElseThrow(WebsiteAccessService::notFound);
        if (scans.hasActiveScan(ownerId, websiteId)) {
            throw new ConflictException(
                    "WEBSITE_HAS_ACTIVE_SCAN",
                    "The website cannot be archived while a scan is active."
            );
        }
        website.archive(clock.instant());
    }

    private WebsiteResponse toResponse(
            WebsiteEntity website,
            WebsiteScanLookup.LatestScanSummary latest
    ) {
        LatestScanResponse latestResponse = latest == null ? null : new LatestScanResponse(
                latest.id(), latest.status(), latest.createdAt(), latest.finishedAt()
        );
        return new WebsiteResponse(
                website.getId(),
                website.getDisplayName(),
                website.getCanonicalUrl(),
                website.getHostname(),
                website.getStatus(),
                latestResponse,
                0,
                0,
                website.getCreatedAt(),
                website.getUpdatedAt()
        );
    }

    private int boundedSize(int size) {
        if (size < 1 || size > MAX_PAGE_SIZE) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_PAGE_SIZE",
                    "Invalid page size",
                    "Page size must be between 1 and 100."
            );
        }
        return size;
    }

    private Sort parseSort(String rawSort) {
        String normalized = rawSort == null ? "updatedAt,desc" : rawSort.strip();
        String[] parts = normalized.split(",", -1);
        if (parts.length != 2 || !List.of("updatedAt", "createdAt", "name").contains(parts[0])) {
            throw invalidSort();
        }
        Sort.Direction direction;
        try {
            direction = Sort.Direction.fromString(parts[1]);
        } catch (IllegalArgumentException exception) {
            throw invalidSort();
        }
        String property = "name".equals(parts[0]) ? "displayName" : parts[0];
        return Sort.by(direction, property).and(Sort.by(Sort.Direction.ASC, "id"));
    }

    private com.weblens.common.exception.ApiException invalidSort() {
        return new com.weblens.common.exception.ApiException(
                org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_SORT",
                "Invalid sort",
                "Sort must use updatedAt, createdAt, or name with asc or desc."
        );
    }

    private ConflictException duplicateWebsite() {
        return new ConflictException("WEBSITE_ALREADY_REGISTERED", "This website is already registered.");
    }

    private WebsiteTarget parseTarget(String rawUrl) {
        try {
            return WebsiteTarget.parse(rawUrl);
        } catch (InvalidWebsiteTargetException exception) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_WEBSITE_URL",
                    "Invalid website URL",
                    exception.getMessage(),
                    exception
            );
        }
    }
}
