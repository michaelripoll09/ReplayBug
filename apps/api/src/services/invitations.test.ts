import { describe, expect, it } from "vitest";
import {
  buildInvitationUrl,
  canInviteInvitationRole,
  getWorkspaceInvitationStatus,
} from "./invitations.js";

describe("workspace invitation service helpers", () => {
  it("keeps invitation privilege grants centralized by actor role", () => {
    expect(canInviteInvitationRole("owner", "admin")).toBe(true);
    expect(canInviteInvitationRole("owner", "member")).toBe(true);
    expect(canInviteInvitationRole("owner", "viewer")).toBe(true);
    expect(canInviteInvitationRole("admin", "admin")).toBe(false);
    expect(canInviteInvitationRole("admin", "member")).toBe(true);
    expect(canInviteInvitationRole("admin", "viewer")).toBe(true);
    expect(canInviteInvitationRole("member", "member")).toBe(false);
    expect(canInviteInvitationRole("viewer", "viewer")).toBe(false);
    expect(canInviteInvitationRole("owner", "owner")).toBe(false);
  });

  it("distinguishes pending, expired, revoked and accepted rows", () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const pending = {
      expiresAt: new Date("2026-09-21T00:00:00.000Z"),
      acceptedAt: null,
      revokedAt: null,
    };
    expect(getWorkspaceInvitationStatus(pending, now)).toBe("pending");
    expect(
      getWorkspaceInvitationStatus(
        { ...pending, expiresAt: new Date("2026-09-19T00:00:00.000Z") },
        now,
      ),
    ).toBe("expired");
    expect(
      getWorkspaceInvitationStatus(
        { ...pending, revokedAt: new Date("2026-09-19T12:00:00.000Z") },
        now,
      ),
    ).toBe("revoked");
    expect(
      getWorkspaceInvitationStatus(
        {
          ...pending,
          expiresAt: new Date("2026-09-19T00:00:00.000Z"),
          revokedAt: new Date("2026-09-19T01:00:00.000Z"),
        },
        now,
      ),
    ).toBe("expired");
    expect(
      getWorkspaceInvitationStatus(
        { ...pending, acceptedAt: new Date("2026-09-19T12:00:00.000Z") },
        now,
      ),
    ).toBe("accepted");
  });

  it("places the one-time token only in the generated invitation URL", () => {
    const url = buildInvitationUrl(
      "http://localhost:3000/",
      "rb_inv_abcdef12_secret-value",
    );
    expect(url).toBe(
      "http://localhost:3000/invite/rb_inv_abcdef12_secret-value",
    );
  });
});
