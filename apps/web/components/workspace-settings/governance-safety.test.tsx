import { describe, expect, it } from "vitest";
import type { WorkspaceAuditEvent } from "@/lib/queries";
import {
  isValidInvitationEmail,
  normalizeInvitationEmail,
} from "./invitations-settings";
import { summarizeAuditEvent } from "./audit-log-settings";
import { isValidWorkspaceSlug } from "./general-settings";

describe("workspace governance safety boundaries", () => {
  it("normalizes invitation email without widening token state", () => {
    expect(normalizeInvitationEmail("  Person@Example.COM ")).toBe(
      "person@example.com",
    );
    expect(isValidInvitationEmail("person@example.com")).toBe(true);
    expect(isValidInvitationEmail("not-an-email")).toBe(false);
  });

  it("validates URL-safe workspace slugs", () => {
    expect(isValidWorkspaceSlug("team-one")).toBe(true);
    expect(isValidWorkspaceSlug("Team One")).toBe(false);
    expect(isValidWorkspaceSlug("team--one")).toBe(false);
  });

  it("summarizes allowlisted audit metadata instead of rendering arbitrary JSON", () => {
    const event = {
      id: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
      projectId: null,
      action: "workspace_invitation.created",
      actor: {
        id: "user-1",
        email: "owner@example.com",
        name: "Owner",
        image: null,
        emailVerified: true,
      },
      metadata: {
        email: "invitee@example.com",
        role: "member",
        token: "rb_inv_secret_should_not_render",
        nested: { unsafe: true },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies WorkspaceAuditEvent;

    const summary = summarizeAuditEvent(event);
    expect(summary).toBe("invitee@example.com · member");
    expect(summary).not.toContain("rb_inv_secret_should_not_render");
    expect(summary).not.toContain("unsafe");
  });
});
