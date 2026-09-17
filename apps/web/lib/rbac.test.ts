import { describe, expect, it } from "vitest";
import {
  canCreateProject,
  canManageEnvironments,
  canManageOrigins,
  canManageProject,
  canManageWorkspace,
  canRotateKeys,
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
});
