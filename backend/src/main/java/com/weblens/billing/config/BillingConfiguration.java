package com.weblens.billing.config;

import com.weblens.billing.gateway.PaymentGateway.Environment;
import com.weblens.billing.gateway.VnpayGateway;
import java.net.URI;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "weblens.billing.enabled", havingValue = "true")
@EnableConfigurationProperties(BillingConfiguration.Properties.class)
public class BillingConfiguration {

    @ConfigurationProperties("weblens.billing")
    @ConditionalOnProperty(name = "weblens.billing.enabled", havingValue = "true")
    public record Properties(String activeProfile, Map<String, Profile> profiles, Map<String, CreditPackage> packages) {
        public Properties {
            profiles = Map.copyOf(profiles == null ? Map.of() : profiles);
            packages = Map.copyOf(packages == null ? Map.of() : packages);
            if (activeProfile == null || !profiles.containsKey(activeProfile) || profiles.isEmpty()
                    || profiles.size() > 8 || packages.isEmpty() || packages.size() > 20) {
                throw new IllegalArgumentException("Billing requires an active profile and credit catalog");
            }
            profiles.keySet().forEach(Properties::requireId);
            packages.keySet().forEach(Properties::requireId);
        }

        private static void requireId(String id) {
            if (!id.matches("[a-z0-9-]{1,40}")) throw new IllegalArgumentException("Invalid billing configuration ID");
        }

        @Override public String toString() { return "BillingProperties[redacted]"; }
    }

    public record Profile(Environment environment, String merchantAccount, String hashSecret,
                          URI checkoutEndpoint, URI returnUrl) {
        public Profile {
            if (environment != Environment.SANDBOX) {
                throw new IllegalArgumentException("Live billing is not enabled in this release");
            }
            // Fail at startup, not after an order has already committed.
            new VnpayGateway(environment, merchantAccount, hashSecret, checkoutEndpoint, returnUrl);
        }

        public VnpayGateway gateway() {
            return new VnpayGateway(environment, merchantAccount, hashSecret, checkoutEndpoint, returnUrl);
        }

        @Override public String toString() { return "VnpayProfile[redacted]"; }
    }

    public record CreditPackage(long amountMinor, String currency, long credits) {
        public CreditPackage {
            if (amountMinor < 1 || amountMinor > 9_999_999_999L || !"VND".equals(currency) || credits < 1) {
                throw new IllegalArgumentException("Invalid sandbox credit package");
            }
        }
    }
}
