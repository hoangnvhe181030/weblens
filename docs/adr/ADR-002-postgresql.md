# Use PostgreSQL as the primary database

Status: Accepted  
Date: 2026-09-01

## Context

V1 needs durable ownership data, scan state, historical measurements, findings, comparisons, and transactional consistency. Relationships and access patterns are central, while exact schema details will evolve.

## Options considered

- PostgreSQL as the authoritative relational store
- A document database as the primary store
- Multiple specialized datastores from the start

## Decision

Use PostgreSQL as the V1 authoritative database. Manage all schema changes with versioned Flyway migrations and test database behavior with Testcontainers. Use relational columns for stable/queryable data and constrained JSON only for genuinely evolving evidence or configuration.

## Consequences

The system gains strong transactions, constraints, mature indexing, SQL querying, and one operational datastore. Schema and query design still require discipline; historical metrics may grow quickly; JSON must not become an unvalidated dumping ground. Specialized search or time-series systems are deferred.

## When to revisit

Revisit when measured retention volume, query latency, write throughput, search capability, or isolation requirements remain unacceptable after sound PostgreSQL modeling, indexing, partitioning, and retention work.
