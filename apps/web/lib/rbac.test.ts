import { describe, expect, it } from "vitest";
import {
  canAssignIssue,
  canCommentOnIssue,
  canCreateProject,
  canManageEnvironments,
  canManageIssueTags,
  canManageOrigins,
  canManageProject,
  canManageWorkspace,
  canRotateKeys,
  canUpdateIssueStatus,
  isReadOnly,
} from "./rbac";

describe("RBAC UX layer (mirrors backend owner/admin/member/viewer)", () => {
  it("owner can do everything", () => {
    expect(canManageWorkspace("owner")).toBe(true);
    expect(canCreateProject("owner")).toBe(true);
    expect(canManageProject("owner")).toBe(true);
    expect(canManageEnvironments("owner")).toBe(true);
    expect(canManageOrigins("owner")).toBe(true);
    expect(canRotateKeys("owner")).toBe(true);
    expect(isReadOnly("owner")).toBe(false);
  });

  it("admin can manage everything except workspace ownership", () => {
    expect(canManageWorkspace("admin")).toBe(false);
    expect(canCreateProject("admin")).toBe(true);
    expect(canManageProject("admin")).toBe(true);
    expect(canManageEnvironments("admin")).toBe(true);
    expect(canManageOrigins("admin")).toBe(true);
    expect(canRotateKeys("admin")).toBe(true);
  });

  it("member and viewer are read-only", () => {
    for (const role of ["member", "viewer"] as const) {
      expect(canCreateProject(role)).toBe(false);
      expect(canManageProject(role)).toBe(false);
      expect(canManageEnvironments(role)).toBe(false);
      expect(canManageOrigins(role)).toBe(false);
      expect(canRotateKeys(role)).toBe(false);
      expect(isReadOnly(role)).toBe(true);
    }
  });

  it("members manage issues while viewers read", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(canUpdateIssueStatus(role)).toBe(true);
      expect(canAssignIssue(role)).toBe(true);
      expect(canManageIssueTags(role)).toBe(true);
      expect(canCommentOnIssue(role)).toBe(true);
    }
    expect(canUpdateIssueStatus("viewer")).toBe(false);
    expect(canAssignIssue("viewer")).toBe(false);
    expect(canManageIssueTags("viewer")).toBe(false);
    expect(canCommentOnIssue("viewer")).toBe(false);
  });
});
