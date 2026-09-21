import { describe, expect, it } from "vitest";
import {
  canChangeMemberRole,
  canDeleteWorkspace,
  canInviteRole,
  canLeaveWorkspace,
  canManageAudit,
  canManageInvitations,
  canManageMembers,
  canRemoveMember,
  canTransferOwnership,
} from "@/lib/rbac";

describe("workspace governance RBAC boundaries", () => {
  it("keeps governance management at the backend admin threshold", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(canManageMembers(role)).toBe(true);
      expect(canManageInvitations(role)).toBe(true);
      expect(canManageAudit(role)).toBe(true);
    }
    for (const role of ["member", "viewer"] as const) {
      expect(canManageMembers(role)).toBe(false);
      expect(canManageInvitations(role)).toBe(false);
      expect(canManageAudit(role)).toBe(false);
    }
  });

  it("keeps transfer and deletion owner-only while allowing non-owner leave", () => {
    expect(canTransferOwnership("owner")).toBe(true);
    expect(canDeleteWorkspace("owner")).toBe(true);
    for (const role of ["admin", "member", "viewer"] as const) {
      expect(canTransferOwnership(role)).toBe(false);
      expect(canDeleteWorkspace(role)).toBe(false);
      expect(canLeaveWorkspace(role)).toBe(true);
    }
  });

  it("matches member hierarchy for role changes and removal", () => {
    expect(canChangeMemberRole("owner", "admin", "member")).toBe(true);
    expect(canChangeMemberRole("admin", "member", "viewer")).toBe(true);
    expect(canChangeMemberRole("admin", "admin", "member")).toBe(false);
    expect(canChangeMemberRole("admin", "viewer", "admin")).toBe(false);
    expect(canChangeMemberRole("member", "viewer", "member")).toBe(false);
    expect(canChangeMemberRole("owner", "owner", "admin")).toBe(false);

    expect(canRemoveMember("owner", "admin")).toBe(true);
    expect(canRemoveMember("admin", "member")).toBe(true);
    expect(canRemoveMember("admin", "admin")).toBe(false);
    expect(canRemoveMember("owner", "owner")).toBe(false);
  });

  it("does not let admins grant admin or owners be invited", () => {
    expect(canInviteRole("owner", "admin")).toBe(true);
    expect(canInviteRole("admin", "member")).toBe(true);
    expect(canInviteRole("admin", "viewer")).toBe(true);
    expect(canInviteRole("admin", "admin")).toBe(false);
    expect(canInviteRole("member", "viewer")).toBe(false);
    expect(canInviteRole("owner", "owner")).toBe(false);
  });
});
