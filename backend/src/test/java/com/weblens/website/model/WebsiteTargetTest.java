package com.weblens.website.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class WebsiteTargetTest {

    @Test
    void canonicalizesHostSchemeDefaultPortAndPath() {
        WebsiteTarget target = WebsiteTarget.parse("HTTPS://ExAmPlE.com:443/docs/../guide?q=1");

        assertThat(target.canonicalUrl()).isEqualTo("https://example.com/guide?q=1");
        assertThat(target.hostname()).isEqualTo("example.com");
    }

    @Test
    void rejectsCredentialsFragmentsAndNonHttpSchemes() {
        assertThatThrownBy(() -> WebsiteTarget.parse("https://user:secret@example.com/"))
                .isInstanceOf(InvalidWebsiteTargetException.class);
        assertThatThrownBy(() -> WebsiteTarget.parse("https://example.com/#private"))
                .isInstanceOf(InvalidWebsiteTargetException.class);
        assertThatThrownBy(() -> WebsiteTarget.parse("file:///etc/passwd"))
                .isInstanceOf(InvalidWebsiteTargetException.class);
    }
}
