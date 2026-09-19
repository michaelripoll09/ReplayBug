import { describe, expect, it } from "vitest";
import { RBAC_MATRIX, hasCapability } from "./policy.js";

describe("capability policy", () => {
  it("owner can do everything", () => {
    for (const cap of Object.keys(
      RBAC_MATRIX.owner,
    ) as (keyof typeof RBAC_MATRIX.owner)[]) {
      expect(hasCapability("owner", cap)).toBe(true);
    }
  });

  it("admin cannot update workspace but can manage projects/keys", () => {
    expect(hasCapability("admin", "workspace:update")).toBe(false);
    expect(hasCapability("admin", "project:create")).toBe(true);
    expect(hasCapability("admin", "key:rotate")).toBe(true);
  });
  it("member/viewer are read-only for writes", () => {
    for (const role of ["member", "viewer"] as const) {
      expect(hasCapability(role, "project:read")).toBe(true);
      expect(hasCapability(role, "environment:read")).toBe(true);
      expect(hasCapability(role, "origin:read")).toBe(true);
      expect(hasCapability(role, "key:read")).toBe(true);
      expect(hasCapability(role, "project:create")).toBe(false);
      expect(hasCapability(role, "environment:write")).toBe(false);
      expect(hasCapability(role, "origin:write")).toBe(false);
      expect(hasCapability(role, "key:rotate")).toBe(false);
    }
  });

  it("restricts secret-token management to owner/admin", () => {
    expect(hasCapability("owner", "project:manage-secret-tokens")).toBe(true);
    expect(hasCapability("admin", "project:manage-secret-tokens")).toBe(true);
    expect(hasCapability("member", "project:manage-secret-tokens")).toBe(false);
    expect(hasCapability("viewer", "project:manage-secret-tokens")).toBe(false);
    expect(RBAC_MATRIX.owner["project:manage-secret-tokens"]).toBe(true);
    expect(RBAC_MATRIX.admin["project:manage-secret-tokens"]).toBe(true);
    expect(RBAC_MATRIX.member["project:manage-secret-tokens"]).toBe(false);
    expect(RBAC_MATRIX.viewer["project:manage-secret-tokens"]).toBe(false);
  });

  it("matches the documented RBAC matrix", () => {
    expect(RBAC_MATRIX.member["project:create"]).toBe(false);
    expect(RBAC_MATRIX.viewer["workspace:read"]).toBe(true);
    expect(RBAC_MATRIX.admin["workspace:update"]).toBe(false);
  });

  it("owner/admin hold every Block 6 issue/session/notification capability", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(hasCapability(role, "issue:read")).toBe(true);
      expect(hasCapability(role, "issue:update-status")).toBe(true);
      expect(hasCapability(role, "issue:assign")).toBe(true);
      expect(hasCapability(role, "issue:manage-tags")).toBe(true);
      expect(hasCapability(role, "issue:comment")).toBe(true);
      expect(hasCapability(role, "session:read")).toBe(true);
      expect(hasCapability(role, "notification:read-own")).toBe(true);
    }
  });

  it("member manages issues but viewer is read-only", () => {
    expect(hasCapability("member", "issue:read")).toBe(true);
    expect(hasCapability("member", "issue:update-status")).toBe(true);
    expect(hasCapability("member", "issue:assign")).toBe(true);
    expect(hasCapability("member", "issue:manage-tags")).toBe(true);
    expect(hasCapability("member", "issue:comment")).toBe(true);
    expect(hasCapability("member", "session:read")).toBe(true);
    expect(hasCapability("member", "notification:read-own")).toBe(true);

    expect(hasCapability("viewer", "issue:read")).toBe(true);
    expect(hasCapability("viewer", "session:read")).toBe(true);
    expect(hasCapability("viewer", "notification:read-own")).toBe(true);
    expect(hasCapability("viewer", "issue:update-status")).toBe(false);
    expect(hasCapability("viewer", "issue:assign")).toBe(false);
    expect(hasCapability("viewer", "issue:manage-tags")).toBe(false);
    expect(hasCapability("viewer", "issue:comment")).toBe(false);
  });
});
