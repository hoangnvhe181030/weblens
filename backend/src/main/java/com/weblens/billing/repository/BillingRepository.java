package com.weblens.billing.repository;

import com.weblens.billing.dto.BillingResponses;
import com.weblens.billing.gateway.PaymentGateway.ProviderIdentity;
import com.weblens.billing.gateway.PaymentGateway.Environment;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class BillingRepository {
    private final JdbcClient jdbc;

    public BillingRepository(JdbcClient jdbc) { this.jdbc = jdbc; }

    public void databaseBudget() {
        jdbc.sql("set local lock_timeout = '4s'").update();
        jdbc.sql("set local statement_timeout = '5s'").update();
    }

    public void ensureAccount(UUID owner) {
        jdbc.sql("insert into credit_accounts(owner_id) values (:owner) on conflict (owner_id) do nothing")
                .param("owner", owner).update();
    }

    public BillingResponses.Balance balance(UUID owner) {
        return jdbc.sql("select balance, held from credit_accounts where owner_id=:owner")
                .param("owner", owner).query((rs, row) -> new BillingResponses.Balance(rs.getLong(1), rs.getLong(2),
                        rs.getLong(1) - rs.getLong(2))).optional().orElse(new BillingResponses.Balance(0, 0, 0));
    }

    public Optional<PaymentOrder> byKey(UUID owner, String hash) {
        return jdbc.sql("select * from payment_orders where owner_id=:owner and idempotency_key_hash=:key")
                .param("owner", owner).param("key", hash).query(BillingRepository::order).optional();
    }

    public Optional<PaymentOrder> ownedOrder(UUID owner, UUID id) {
        return jdbc.sql("select * from payment_orders where owner_id=:owner and id=:id")
                .param("owner", owner).param("id", id).query(BillingRepository::order).optional();
    }

    public Optional<PaymentOrder> lockOrder(ProviderIdentity identity, String reference) {
        return jdbc.sql("""
                select * from payment_orders where provider=:provider and environment=:environment
                and merchant_account=:merchant and reference=:reference for no key update
                """)
                .param("provider", identity.provider()).param("environment", identity.environment().name())
                .param("merchant", identity.merchantAccount()).param("reference", reference)
                .query(BillingRepository::order).optional();
    }

    public void insert(PaymentOrder order, String keyHash) {
        jdbc.sql("""
                insert into payment_orders(id, owner_id, provider, environment, merchant_account, profile_id,
                    reference, package_id, amount_minor, currency, credits, idempotency_key_hash,
                    request_fingerprint_hash, created_at, expires_at, updated_at)
                values (:id,:owner,:provider,:environment,:merchant,:profile,:reference,:packageId,
                    :amount,:currency,:credits,:key,:fingerprint,:created,:expires,:created)
                """)
                .param("id", order.id()).param("owner", order.ownerId()).param("provider", order.identity().provider())
                .param("environment", order.identity().environment().name()).param("merchant", order.identity().merchantAccount())
                .param("profile", order.profileId()).param("reference", order.reference()).param("packageId", order.packageId())
                .param("amount", order.amountMinor()).param("currency", order.currency()).param("credits", order.credits())
                .param("key", keyHash).param("fingerprint", order.fingerprint())
                .param("created", timestamp(order.createdAt())).param("expires", timestamp(order.expiresAt())).update();
    }

    public void credit(PaymentOrder order, String providerTransaction, Instant paidAt, Instant now) {
        int updated = jdbc.sql("""
                update credit_accounts set balance=balance+:credits, updated_at=clock_timestamp()
                where owner_id=:owner
                """).param("credits", order.credits()).param("owner", order.ownerId()).update();
        if (updated != 1) throw new IllegalStateException("Payment account is missing");
        jdbc.sql("""
                insert into credit_ledger(owner_id, operation, payment_order_id, balance_delta, held_delta)
                values (:owner, 'TOPUP', :order, :credits, 0)
                """).param("owner", order.ownerId()).param("order", order.id()).param("credits", order.credits()).update();
        jdbc.sql("""
                update payment_orders set status='PAID', provider_transaction_id=:transaction,
                    paid_at=:paidAt, settled_at=:now, updated_at=greatest(created_at,:now)
                where id=:id
                """).param("transaction", providerTransaction).param("paidAt", timestamp(paidAt))
                .param("now", timestamp(now)).param("id", order.id()).update();
    }

    public void recordNotSucceeded(UUID order) {
        jdbc.sql("update payment_orders set status='NOT_SUCCEEDED', updated_at=greatest(created_at,clock_timestamp()) where id=:id")
                .param("id", order).update();
    }

    public List<BillingResponses.LedgerEntry> history(UUID owner, Instant beforeTime, long beforeId, int limit) {
        return jdbc.sql("""
                select * from credit_ledger where owner_id=:owner and (created_at,id)<(:time,:id)
                order by created_at desc,id desc limit :limit
                """).param("owner", owner).param("time", timestamp(beforeTime)).param("id", beforeId).param("limit", limit)
                .query((rs, row) -> new BillingResponses.LedgerEntry(rs.getLong("id"), rs.getString("operation"),
                        rs.getLong("balance_delta"), rs.getLong("held_delta"), rs.getObject("payment_order_id", UUID.class),
                        rs.getObject("reservation_scan_id", UUID.class), instant(rs, "created_at"))).list();
    }

    private static PaymentOrder order(ResultSet rs, int row) throws SQLException {
        return new PaymentOrder(rs.getObject("id", UUID.class), rs.getObject("owner_id", UUID.class),
                new ProviderIdentity(rs.getString("provider"), Environment.valueOf(rs.getString("environment")), rs.getString("merchant_account")),
                rs.getString("profile_id"), rs.getString("reference"), rs.getString("package_id"), rs.getLong("amount_minor"),
                rs.getString("currency"), rs.getLong("credits"), rs.getString("request_fingerprint_hash"), rs.getString("status"),
                rs.getString("provider_transaction_id"), instant(rs, "created_at"), instant(rs, "expires_at"), instant(rs, "settled_at"));
    }

    public record PaymentOrder(UUID id, UUID ownerId, ProviderIdentity identity, String profileId, String reference,
                               String packageId, long amountMinor, String currency, long credits, String fingerprint,
                               String status, String transactionId, Instant createdAt, Instant expiresAt, Instant settledAt) {
        public BillingResponses.Order response() {
            return new BillingResponses.Order(id, packageId, amountMinor, currency, credits, status, createdAt, expiresAt, settledAt);
        }
    }

    public static OffsetDateTime timestamp(Instant value) {
        return value == null ? null : OffsetDateTime.ofInstant(value, ZoneOffset.UTC);
    }

    private static Instant instant(ResultSet rs, String field) throws SQLException {
        OffsetDateTime value = rs.getObject(field, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }
}
