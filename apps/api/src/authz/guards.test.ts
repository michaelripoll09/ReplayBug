import { describe, expect, it } from "vitest";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
  requireAuthenticatedUser,
} from "./guards.js";
import { DomainError } from "../errors.js";

describe("authz guards", () => {
  it("requireAuthenticatedUser throws AUTH_REQUIRED for null", () => {
    try {
      requireAuthenticatedUser(null);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe("AUTH_REQUIRED");
    }
  });

  it("requireWorkspaceMembership throws NOT_FOUND for anti-enumeration", () => {
    try {
      requireWorkspaceMembership(undefined);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe("NOT_FOUND");
    }
  });

  it("requireWorkspaceCapability throws FORBIDDEN for under-privileged", () => {
    try {
      requireWorkspaceCapability(
        { workspaceId: "w", userId: "u", role: "viewer" },
        "project:create",
      );
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe("FORBIDDEN");
    }
  });

  it("requireProjectAccess throws NOT_FOUND for cross-workspace", () => {
    try {
      requireProjectAccess(
        { workspaceId: "w1", userId: "u", role: "owner" },
        { id: "p", workspaceId: "w2" },
      );
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe("NOT_FOUND");
    }
  });

  it("requireProjectAccess passes for same workspace", () => {
    const m = requireProjectAccess(
      { workspaceId: "w1", userId: "u", role: "member" },
      { id: "p", workspaceId: "w1" },
    );
    expect(m.role).toBe("member");
  });
});
