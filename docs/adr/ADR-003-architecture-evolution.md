# Introduce architecture complexity only for measured requirements

Status: Accepted  
Date: 2026-09-01

## Context

Kafka, Redis, microservices, Kubernetes, RAG, and ML can be relevant to WebLens, but each adds failure modes, operational load, security surface, and cognitive cost. Bootstrap architecture must not present future possibilities as current capabilities.

## Options considered

- Adopt a comprehensive distributed stack immediately
- Ban future infrastructure additions to preserve simplicity
- Evolve architecture through evidence and ADRs

## Decision

Begin with the smallest architecture that meets validated requirements. Introduce a technology only after documenting the concrete problem, measurements or constraints, simpler alternatives, ownership/operational plan, failure behavior, and success criteria in an ADR.

## Consequences

The repository remains approachable and development focuses on product learning. Some capabilities may require later migrations, and teams must invest in measurement before choosing tools. Technology choices become reviewable decisions rather than silent drift.

## When to revisit

Revisit this principle only if governance itself blocks urgent, demonstrated reliability or security work. Individual technologies should be evaluated in their own ADRs when trigger conditions arise.
