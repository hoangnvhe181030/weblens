package com.weblens.billing.service;

import com.weblens.billing.model.UsageBillingPolicy;
import com.weblens.billing.model.UsageBillingPolicy.Reservation;
import com.weblens.billing.model.UsageBillingPolicy.Settlement;
import com.weblens.billing.model.UsageBillingPolicy.TerminalEvidence;
import com.weblens.billing.repository.BillingRepository;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Foundation only: no user endpoint or scan caller until the versioned billable-evidence contract exists. */
@Service
@Transactional(propagation = Propagation.MANDATORY)
public class UsageReservationService {
    private final JdbcClient jdbc;
    private final BillingRepository billing;
    private final UsageBillingPolicy policy = new UsageBillingPolicy();

    public UsageReservationService(JdbcClient jdbc, BillingRepository billing) { this.jdbc = jdbc; this.billing = billing; }

    public void reserve(UUID owner, UUID scanId, int maxPages, long creditsPerPage) {
        var requested = new Reservation(maxPages, creditsPerPage);
        billing.databaseBudget();
        var scan = lockScan(owner, scanId);
        var existing = jdbc.sql("select max_pages,credits_per_page from usage_reservations where scan_id=:id")
                .param("id", scanId).query((rs, row) -> new Reservation(rs.getInt(1), rs.getLong(2))).optional();
        if (existing.isPresent()) {
            if (!existing.get().equals(requested)) throw conflict("RESERVATION_CONFLICT");
            return;
        }
        if (!"QUEUED".equals(scan.status()) || scan.maxPages() != maxPages) throw conflict("SCAN_RESERVATION_MISMATCH");
        billing.ensureAccount(owner);
        // Account is the last mutable lock. NO KEY UPDATE remains compatible with implicit FK KEY SHARE.
        int held = jdbc.sql("""
                update credit_accounts set held=held+:credits,updated_at=clock_timestamp()
                where owner_id=:owner and balance-held>=:credits
                """).param("owner", owner).param("credits", requested.reservedCredits()).update();
        if (held != 1) throw conflict("INSUFFICIENT_CREDITS");
        jdbc.sql("""
                insert into usage_reservations(scan_id,owner_id,max_pages,credits_per_page,reserved_credits,policy_version)
                values (:scan,:owner,:pages,:price,:credits,:policy)
                """).param("scan", scanId).param("owner", owner).param("pages", maxPages).param("price", creditsPerPage)
                .param("credits", requested.reservedCredits()).param("policy", UsageBillingPolicy.VERSION).update();
        jdbc.sql("""
                insert into credit_ledger(owner_id,operation,reservation_scan_id,balance_delta,held_delta)
                values (:owner,'RESERVE',:scan,0,:credits)
                """).param("owner", owner).param("scan", scanId).param("credits", requested.reservedCredits()).update();
    }

    /** Trusted application call only. Never construct this evidence from public succeededCount. */
    public Settlement finalizeUsage(UUID owner, UUID scanId, long evidenceVersion, TerminalEvidence evidence) {
        billing.databaseBudget();
        var scan = lockScan(owner, scanId);
        var stored = jdbc.sql("select * from usage_reservations where scan_id=:id and owner_id=:owner for no key update")
                .param("id", scanId).param("owner", owner).query((rs, row) -> new StoredReservation(
                        new Reservation(rs.getInt("max_pages"), rs.getLong("credits_per_page")),
                        rs.getString("policy_version"), rs.getString("status"), rs.getLong("evidence_version"),
                        rs.getString("terminal_outcome"), rs.getInt("billable_pages"), rs.getLong("charged_credits"),
                        rs.getLong("released_credits"))).optional()
                .orElseThrow(() -> new NotFoundException("RESERVATION_NOT_FOUND", "Usage reservation not found."));
        if (!UsageBillingPolicy.VERSION.equals(stored.policy())) throw conflict("UNSUPPORTED_BILLING_POLICY");
        var result = policy.settle(stored.reservation(), evidence);
        if ("FINALIZED".equals(stored.status())) {
            if (stored.evidenceVersion() != evidenceVersion || !stored.outcome().equals(evidence.outcome().name())
                    || stored.billablePages() != result.billablePages() || stored.charged() != result.chargedCredits()) {
                throw conflict("SETTLEMENT_EVIDENCE_CONFLICT");
            }
            return new Settlement(stored.billablePages(), stored.charged(), stored.released());
        }
        String expectedStatus = switch (evidence.outcome()) {
            case COMPLETED -> "COMPLETED";
            case PARTIAL_SUCCESS -> "PARTIAL_SUCCESS";
            case USER_CANCELLED -> "CANCELLED";
            case INTERNAL_FAILURE -> "FAILED";
        };
        if (evidenceVersion < 1 || scan.remoteVersion() != evidenceVersion || !expectedStatus.equals(scan.status())) {
            throw conflict("TERMINAL_EVIDENCE_MISMATCH");
        }
        long reserved = stored.reservation().reservedCredits();
        int updated = jdbc.sql("""
                update credit_accounts set balance=balance-:charged,held=held-:reserved,updated_at=clock_timestamp()
                where owner_id=:owner and held>=:reserved and balance>=:charged
                """).param("owner", owner).param("charged", result.chargedCredits()).param("reserved", reserved).update();
        if (updated != 1) throw new IllegalStateException("Usage account projection is inconsistent");
        jdbc.sql("""
                update usage_reservations set status='FINALIZED',evidence_version=:version,terminal_outcome=:outcome,
                    billable_pages=:pages,charged_credits=:charged,released_credits=:released,finalized_at=clock_timestamp()
                where scan_id=:scan
                """).param("version", evidenceVersion).param("outcome", evidence.outcome().name())
                .param("pages", result.billablePages()).param("charged", result.chargedCredits())
                .param("released", result.releasedCredits()).param("scan", scanId).update();
        jdbc.sql("""
                insert into credit_ledger(owner_id,operation,reservation_scan_id,balance_delta,held_delta)
                values (:owner,'FINALIZE',:scan,:balance,:held)
                """).param("owner", owner).param("scan", scanId).param("balance", -result.chargedCredits())
                .param("held", -reserved).update();
        return result;
    }

    private ScanSnapshot lockScan(UUID owner, UUID id) {
        return jdbc.sql("""
                select status,max_pages,remote_execution_version from scans
                where id=:id and requested_by_user_id=:owner for no key update
                """).param("id", id).param("owner", owner).query((rs, row) -> new ScanSnapshot(rs.getString(1), rs.getInt(2), rs.getLong(3)))
                .optional().orElseThrow(() -> new NotFoundException("SCAN_NOT_FOUND", "Scan not found."));
    }

    private static ConflictException conflict(String code) { return new ConflictException(code, "Billing operation conflicts with the durable state."); }
    private record ScanSnapshot(String status, int maxPages, long remoteVersion) { }
    private record StoredReservation(Reservation reservation, String policy, String status, long evidenceVersion,
                                     String outcome, int billablePages, long charged, long released) { }
}
