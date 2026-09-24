# ADR 0004 — Semantic timeline instead of DOM/video replay

Status: accepted

## Problem

Investigating a browser failure needs the sequence that led to it, but recording a
full DOM or video session increases privacy exposure, payload volume, storage cost,
and replay implementation complexity. ReplayBug must also produce useful evidence
when a recording could not be captured.

## Options considered

1. **DOM/video replay.** Rich visual context, but captures far more user data, needs
   heavier client/storage infrastructure, and is not required to generate a stable
   test. Rejected.
2. **Error-only reporting.** Low cost, but loses the navigation and interaction
   context needed to understand or reproduce a failure. Rejected.
3. **Bounded semantic timeline (chosen).** Capture ordered navigation, click, safe
   input, network, console, and failure events with sanitized metadata; display a
   bounded session window and derive a reproduction plan from it.

## Decision

- The SDK emits semantic events and breadcrumbs, not DOM snapshots, screen pixels, or
  media.
- The API validates and redacts event payloads before durable storage. Session event
  reads and timeline-context routes expose allowlisted summaries rather than raw
  payload bags.
- The reproduction generator uses retained timeline evidence (up to its documented
  bounded window), safe same-origin routes, and ranked semantic locators.
- Raw evidence follows project retention. Lifetime issue aggregates and completed
  reproduction history have their documented separate retention behavior.

## Consequences

- A timeline is explainable, smaller, and compatible with privacy-safe defaults; it
  is sufficient for deterministic Playwright generation when evidence is available.
- ReplayBug does not provide visual replay, DOM inspection, or pixel-perfect session
  reconstruction. A developer still needs application knowledge to diagnose context
  not represented by semantic events.
- The approach makes locator quality observable: `test_id`, role/name, and label are
  preferred, while brittle CSS fallback is warned.

See [reproduction generator](../architecture/reproduction-generator.md) and
[privacy defaults](0005-privacy-safe-input-defaults.md).
