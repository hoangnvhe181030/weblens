package com.weblens.billing.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.billing.controller.PaymentController;
import com.weblens.billing.gateway.PaymentGateway.Environment;
import java.net.URI;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class BillingConfigurationTest {
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(BillingConfiguration.class, ApplicationPropertyScan.class);
    private final String[] configured = {
            "weblens.billing.enabled=true", "weblens.billing.active-profile=sandbox-v1",
            "weblens.billing.profiles.sandbox-v1.environment=SANDBOX",
            "weblens.billing.profiles.sandbox-v1.merchant-account=TEST0001",
            "weblens.billing.profiles.sandbox-v1.hash-secret=unit-test-signing-key-not-a-credential",
            "weblens.billing.profiles.sandbox-v1.checkout-endpoint=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
            "weblens.billing.profiles.sandbox-v1.return-url=https://example.test/return",
            "weblens.billing.packages.starter.amount-minor=10000",
            "weblens.billing.packages.starter.currency=VND", "weblens.billing.packages.starter.credits=1000"
    };

    @Test
    void disabledByDefaultNeedsNoCredentialOrCatalogAndDoesNotRegisterController() {
        runner.withUserConfiguration(PaymentController.class).run(context -> {
            assertThat(context).hasNotFailed().doesNotHaveBean(BillingConfiguration.Properties.class)
                    .doesNotHaveBean(PaymentController.class);
        });
    }

    @Test
    void explicitlyDisabledDoesNotBindEvenInvalidBillingProperties() {
        runner.withUserConfiguration(PaymentController.class)
                .withPropertyValues("weblens.billing.enabled=false", "weblens.billing.active-profile=missing")
                .run(context -> assertThat(context).hasNotFailed()
                        .doesNotHaveBean(BillingConfiguration.Properties.class)
                        .doesNotHaveBean(PaymentController.class));
    }

    @Test
    void bindsExternalSandboxProfilesAndCatalog() {
        runner.withPropertyValues(configured).run(context -> {
            assertThat(context).hasNotFailed().hasSingleBean(BillingConfiguration.Properties.class);
            var config = context.getBean(BillingConfiguration.Properties.class);
            assertThat(config.profiles().get("sandbox-v1").gateway().identity().merchantAccount()).isEqualTo("TEST0001");
            assertThat(config.packages().get("starter").credits()).isEqualTo(1_000);
            assertThat(config.toString()).doesNotContain("unit-test-signing-key");
            assertThat(config.profiles().get("sandbox-v1").toString()).doesNotContain("unit-test-signing-key");
        });
    }

    @Test
    void enabledMissingConfigFailsClosed() {
        runner.withPropertyValues("weblens.billing.enabled=true").run(context -> assertThat(context).hasFailed());
    }

    @Test
    void liveCannotBeEnabledByChangingUrlOrEnvironment() {
        assertThatThrownBy(() -> new BillingConfiguration.Profile(Environment.LIVE, "TEST0001",
                "unit-test-signing-key-not-a-credential", URI.create("https://live.example/pay"), URI.create("https://example.test/return")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Live billing");
        runner.withPropertyValues(configured)
                .withPropertyValues("weblens.billing.profiles.sandbox-v1.environment=LIVE")
                .run(context -> assertThat(context).hasFailed());
    }

    @TestConfiguration(proxyBeanMethods = false)
    @ConfigurationPropertiesScan(basePackageClasses = BillingConfiguration.class)
    static class ApplicationPropertyScan {}
}
