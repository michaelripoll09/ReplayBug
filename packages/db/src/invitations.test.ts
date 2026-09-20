import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INVITATION_EXPIRY_DAYS,
  INVITATION_ROLES,
  INVITATION_TOKEN_PREFIX,
  InvitationEmailError,
  InvitationRoleError,
  InvitationTokenError,
  defaultInvitationExpiry,
  extractInvitationTokenPrefix,
  generateInvitationToken,
  hashInvitationToken,
  normalizeInvitationEmail,
  parseInvitationToken,
  validateInvitationRole,
  verifyInvitationToken,
} from "./invitations.js";

describe("invitation token primitives", () => {
  it("generates high-entropy tokens with a stable, non-secret prefix", () => {
    const first = generateInvitationToken();
    const second = generateInvitationToken();

    expect(first.token).toMatch(
      new RegExp(`^${INVITATION_TOKEN_PREFIX}[0-9a-f]{8}_[A-Za-z0-9_-]{43}$`),
    );
    expect(first.token).not.toBe(second.token);
    expect(first.tokenPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(first.token).toContain(`_${first.tokenPrefix}_`);
    expect(extractInvitationTokenPrefix(first.token)).toBe(first.tokenPrefix);
    expect(parseInvitationToken(first.token).token).toBe(first.token);
  });

  it("hashes the complete token with SHA-256 and never uses plaintext as storage metadata", () => {
    const generated = generateInvitationToken();
    const expected = createHash("sha256")
      .update(generated.token, "utf8")
      .digest("hex");

    expect(generated.tokenHash).toBe(expected);
    expect(generated.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.tokenHash).not.toContain(generated.token);
    expect(verifyInvitationToken(generated.token, generated.tokenHash)).toBe(
      true,
    );
    expect(
      verifyInvitationToken(
        generateInvitationToken().token,
        generated.tokenHash,
      ),
    ).toBe(false);
  });

  it("rejects malformed tokens and does not echo candidate secrets", () => {
    const token = generateInvitationToken().token;
    const malformed = `${token}unexpected`;

    expect(() => parseInvitationToken("not-an-invitation")).toThrow(
      InvitationTokenError,
    );
    expect(() => parseInvitationToken(malformed)).toThrow(
      /Invalid invitation token format/,
    );
    expect(() => extractInvitationTokenPrefix("rb_inv_bad")).toThrow(
      InvitationTokenError,
    );
    expect(() => hashInvitationToken("plaintext-secret")).toThrow(
      InvitationTokenError,
    );
    expect(() => validateInvitationRole("owner")).toThrow(InvitationRoleError);
    expect(
      JSON.stringify(
        new InvitationTokenError("Invalid invitation token format"),
      ),
    ).not.toContain(token);
  });
});

describe("invitation email and expiry primitives", () => {
  it("normalizes emails by trimming and lowercasing", () => {
    expect(normalizeInvitationEmail("  Alice+Replay@Example.COM ")).toBe(
      "alice+replay@example.com",
    );
    expect(() => normalizeInvitationEmail("not-an-email")).toThrow(
      InvitationEmailError,
    );
    expect(() => normalizeInvitationEmail("  ")).toThrow(InvitationEmailError);
  });

  it("uses a seven-day default expiry from the supplied clock", () => {
    const now = new Date("2026-09-19T12:00:00.000Z");
    const expiry = defaultInvitationExpiry(now);
    expect(expiry.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(expiry.getTime() - now.getTime()).toBe(
      INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(generateInvitationToken(now).expiresAt).toEqual(expiry);
  });

  it("accepts only non-owner invitation roles", () => {
    expect(INVITATION_ROLES).toEqual(["admin", "member", "viewer"]);
    for (const role of INVITATION_ROLES) {
      expect(validateInvitationRole(role)).toBe(role);
    }
    expect(() => validateInvitationRole("owner")).toThrow(InvitationRoleError);
    expect(() => validateInvitationRole("ADMIN")).toThrow(InvitationRoleError);
  });
});
