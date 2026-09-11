# Initial Domain

These concepts establish vocabulary, not final classes or database tables.

## User

An authenticated actor who owns websites and all derived scan data. Identity credentials and lifecycle belong to the Identity module.

## Website

A user-owned registration of an HTTP(S) target, including its normalized root and scan eligibility state. It is not proof of domain ownership unless V1 explicitly adds verification.

## Scan

One bounded observation of a Website. It owns a configuration snapshot, lifecycle state, timing, progress, collection/version metadata, and terminal outcome. A scan can be partial without being treated as complete.

## ScanPage

The outcome of attempting one normalized URL within a Scan: fetch status, timing, response metadata, and error classification. It associates Metrics and Findings with the observed page.

## Metric

A named, typed measurement with unit, value, collection method/version, and subject (scan or page). Historical comparison requires compatible meaning and version, not merely the same name.

## Finding

A deterministic observation derived from scan evidence, such as a failed request or breached threshold. It records its rule/version and supporting evidence.

## Regression

A future V2 concept: a material negative difference between a baseline Scan and candidate Scan. It references the compared evidence, threshold/rule version, affected subject, and severity. It is not part of the V1/V1.5 implementation scope.

## AIAnalysis

A future V3 concept: an optional explanation generated from a bounded Regression evidence package. It records generation metadata and output but cannot replace or mutate the underlying deterministic Regression. It is not part of the V1/V1.5 implementation scope.

## Relationships

A User owns Websites; a Website has many Scans; a Scan has many ScanPages, Metrics, and Findings. From V2, a Regression compares two Scans from one Website; from V3, an AIAnalysis explains one or more explicitly referenced Regressions. Ownership is always derived through the Website/User boundary.
