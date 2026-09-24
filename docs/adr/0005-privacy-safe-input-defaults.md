# ADR 0005 — Privacy-safe input capture defaults

Status: accepted

## Problem

Browser interaction evidence can make a reproduction useful, but input values may
contain passwords, tokens, payment data, or personal information. A capture setting
that is convenient by default can silently turn observability into data collection.

## Options considered

1. **Capture every input value.** Most complete replay data, but unacceptable default
   privacy and secret-exposure risk. Rejected.
2. **Capture no input interaction.** Safest, but removes useful evidence that a field
   was involved. Rejected.
3. **Capture input interaction without values by default; explicitly allow safe
   selectors (chosen).** Preserve a bounded semantic event while making value capture
   opt-in and subject to redaction.

## Decision

- `captureSafeInputs` defaults to `false`. An operator must enable it and provide
  `safeInputSelectors` before safe values are eligible for capture.
- Password, secret/token, card-like, masked, ignored, and other sensitive-looking
  values are redacted or omitted. Server-side sanitization repeats the boundary.
- Reproduction rendering never restores a redacted value. It emits
  `REPLACE_WITH_TEST_VALUE` and marks the generated test as having redacted steps.
- Dashboard/API DTOs expose allowlisted summaries and render untrusted strings as
  text; secrets and raw telemetry payload bags are not surfaced as general output.

## Consequences

- The default protects users even when application teams do not configure selectors.
- A reproduction may require a developer to provide a synthetic test value; that
  explicit work is preferable to retaining a real secret.
- Privacy controls reduce the fidelity of some timelines by design and must remain
  covered by SDK, API, and E2E tests.

See [reproduction generator](../architecture/reproduction-generator.md),
[tenancy and retention](../architecture/tenancy.md), and the
[semantic-timeline ADR](0004-semantic-timeline-over-video-replay.md).
