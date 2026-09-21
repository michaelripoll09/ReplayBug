import { describe, expect, it } from "vitest";
import { ApiError } from "@replaybug/api-client";
import { toUiError, fieldErrorsFromApiError } from "./errors";

describe("toUiError", () => {
  it("maps 401 to a clean login prompt", () => {
    const ui = toUiError(
      new ApiError({
        code: "AUTH_REQUIRED",
        message: "x",
        status: 401,
        requestId: "r1",
      }),
    );
    expect(ui.kind).toBe("auth");
    expect(ui.message).toMatch(/sign in/i);
  });

  it("maps 403/404 without leaking internals", () => {
    expect(
      toUiError(
        new ApiError({
          code: "FORBIDDEN",
          message: "Forbidden",
          status: 403,
          requestId: "r",
        }),
      ).kind,
    ).toBe("forbidden");
    const notFound = toUiError(
      new ApiError({
        code: "NOT_FOUND",
        message: "Workspace not found",
        status: 404,
        requestId: "r",
      }),
    );
    expect(notFound.kind).toBe("not-found");
    expect(JSON.stringify(notFound)).not.toMatch(/SELECT|cookie|hash/i);
  });

  it("keeps requestId on server errors", () => {
    const ui = toUiError(
      new ApiError({
        code: "INTERNAL_ERROR",
        message: "bad",
        status: 500,
        requestId: "req-9",
      }),
    );
    expect(ui.requestId).toBe("req-9");
  });
});

describe("fieldErrorsFromApiError", () => {
  it("extracts path->message pairs and ignores junk", () => {
    const error = new ApiError({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      status: 400,
      requestId: "r",
      details: [
        { path: "name", message: "Required" },
        { path: "", message: "" },
        "junk",
      ],
    });
    expect(fieldErrorsFromApiError(error)).toEqual({ name: "Required" });
  });
});
