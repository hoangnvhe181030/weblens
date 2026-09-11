package com.weblens.website.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.exception.NotFoundException;
import com.weblens.website.entity.WebsiteEntity;
import com.weblens.website.model.WebsiteStatus;
import com.weblens.website.repository.WebsiteRepository;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class WebsiteAccessService {

    private final WebsiteRepository websites;
    private final CurrentUserService currentUsers;

    public WebsiteAccessService(WebsiteRepository websites, CurrentUserService currentUsers) {
        this.websites = websites;
        this.currentUsers = currentUsers;
    }

    public void requireOwnedActive(UUID ownerId, UUID websiteId) {
        currentUsers.requireActive(ownerId);
        websites.findByIdAndOwnerId(websiteId, ownerId)
                .filter(website -> website.getStatus() == WebsiteStatus.ACTIVE)
                .orElseThrow(WebsiteAccessService::notFound);
    }

    @Transactional
    public WebsiteTargetSnapshot lockOwnedActive(UUID ownerId, UUID websiteId) {
        currentUsers.requireActive(ownerId);
		WebsiteEntity website = websites.findForUpdate(websiteId, ownerId, WebsiteStatus.ACTIVE)
				.orElseThrow(WebsiteAccessService::notFound);
		return new WebsiteTargetSnapshot(
				website.getId(), website.getOwnerId(), website.getCanonicalUrl(), website.getHostname()
		);
    }

    static NotFoundException notFound() {
        return new NotFoundException("WEBSITE_NOT_FOUND", "The website does not exist.");
    }

	public record WebsiteTargetSnapshot(
			UUID websiteId,
			UUID ownerId,
			String canonicalUrl,
			String hostname
	) {
	}
}
