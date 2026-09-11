package com.weblens.website.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record UpdateWebsiteRequest(@NotBlank @Size(max = 120) String name) {
}
