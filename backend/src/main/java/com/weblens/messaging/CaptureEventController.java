package com.weblens.messaging;

import com.weblens.messaging.contract.CaptureEventEnvelope;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/v1/events")
public class CaptureEventController {

    private final CaptureEventService events;

    public CaptureEventController(CaptureEventService events) {
        this.events = events;
    }

    @PostMapping("/captures")
    ResponseEntity<Map<String, Object>> consume(@Valid @RequestBody CaptureEventEnvelope envelope) {
        CaptureEventService.ConsumeResult result = events.consume(envelope);
        return ResponseEntity.ok(Map.of(
                "accepted", true,
                "duplicate", result.duplicate(),
                "outcome", result.outcome()
        ));
    }
}
