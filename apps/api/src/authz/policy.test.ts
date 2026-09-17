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

  it("matches the documented RBAC matrix", () => {
    expect(RBAC_MATRIX.member["project:create"]).toBe(false);
    expect(RBAC_MATRIX.viewer["workspace:read"]).toBe(true);
    expect(RBAC_MATRIX.admin["workspace:update"]).toBe(false);
  });
});
