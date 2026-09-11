package com.weblens.messaging;

import com.weblens.messaging.contract.ScanEventEnvelope;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/v1/events")
public class ScanEventController {

    private final ScanEventService events;

    public ScanEventController(ScanEventService events) {
        this.events = events;
    }

    @PostMapping("/scans")
    ResponseEntity<Map<String, Object>> consume(@Valid @RequestBody ScanEventEnvelope envelope) {
        ScanEventService.ConsumeResult result = events.consume(envelope);
        return ResponseEntity.ok(Map.of(
                "accepted", true,
                "duplicate", result.duplicate(),
                "outcome", result.outcome()
        ));
    }
}
