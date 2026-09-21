# Security Policy

ReplayBug is an educational, self-hosted developer tool. No production
hosting commitment is made by this repository; anyone deploying it
accepts responsibility for their own hardening, backups and updates.

## Supported versions and updates

Only the current code on the `main` branch and the latest published release
are supported for security fixes. Older releases may not receive backports.
Self-hosted operators are responsible for monitoring releases, applying
updates promptly, and validating updates in their own environments.

## Reporting a vulnerability

- **Do not open a public issue** for anything you believe is a security
  vulnerability.
- Report privately through a **GitHub Security Advisory** on this
  repository ("Security" tab → "Report a vulnerability"). That keeps the
  details visible only to maintainers until a fix exists.
- This project has no dedicated security email — the private advisory
  channel above is the only reporting route. Do not invent or trust any
  address found outside this file.
- Include the affected version or commit, steps to reproduce, impact, and
  any suggested fix. Do not include secrets, access tokens, credentials,
  production telemetry, or other private data; redact or minimize any
  reproducer data.

## Scope notes for reviewers

- Authentication is email/password via an established auth library with
  HttpOnly session cookies; GitHub OAuth exists only when configured.
- Public ingest keys are write-only telemetry credentials; secret project
  tokens are hashed at rest and shown once.
- Dashboard authorization is enforced server-side per role
  (owner/admin/member/viewer); the web UI only hides controls.
- Telemetry is sanitized client- and server-side; the dashboard renders
  telemetry as escaped text and comments through sanitized Markdown
  (see `docs/architecture/dashboard.md`, "Output security").
- No email/SMS/push notification infrastructure exists by design
  (in-app notifications only).

## Out of scope

Social engineering, physical attacks, and vulnerabilities in third-party
infrastructure (PostgreSQL, Docker, hosting providers) are out of scope,
though dependency reports via `pnpm audit` with reproducible steps are
welcome as regular issues when they affect this repository's lockfile.
