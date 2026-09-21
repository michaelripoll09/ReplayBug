import { describe, expect, it } from "vitest";
import {
  assertNoSymlinkEscape,
  canonicalizeArtifactPath,
  resolveArtifactUploadPath,
} from "./artifact-paths.js";
import { ArtifactPathError } from "./errors.js";

/**
 * RS-06 path canonicalization (TDD): user-supplied `artifactPath` values
 * become canonical POSIX relative paths ONLY after containment inside the
 * upload root is proven. Every traversal shape — including Windows,
 * drive-letter, UNC, reserved-name, control-char and percent-encoded
 * variants — must be rejected, never normalized into something loadable.
 */
describe("canonicalizeArtifactPath", () => {
  it("accepts canonical POSIX relative paths verbatim", () => {
    expect(canonicalizeArtifactPath("assets/app.js.map")).toBe(
      "assets/app.js.map",
    );
    expect(canonicalizeArtifactPath("app.map")).toBe("app.map");
    expect(canonicalizeArtifactPath("dist/assets/app-abc123.js")).toBe(
      "dist/assets/app-abc123.js",
    );
  });

  it("converts Windows separators to POSIX", () => {
    expect(canonicalizeArtifactPath("dist\\assets\\app.js.map")).toBe(
      "dist/assets/app.js.map",
    );
    expect(canonicalizeArtifactPath("dist\\assets/app.js.map")).toBe(
      "dist/assets/app.js.map",
    );
  });

  it("rejects redundant separators instead of collapsing them", () => {
    expect(() => canonicalizeArtifactPath("dist//assets/app.js.map")).toThrow(
      ArtifactPathError,
    );
  });

  it.each([
    ["parent prefix", "../foo"],
    ["nested parent", "foo/../../bar"],
    ["bare dotdot", ".."],
    ["dotdot file", "assets/../evil.map"],
    ["dot segment", "./foo"],
    ["bare dot", "."],
    ["absolute posix", "/foo"],
    ["absolute nested", "/assets/app.js.map"],
    ["drive backslash", "C:\\foo"],
    ["drive slash", "C:/foo"],
    ["drive relative", "C:foo"],
    ["lowercase drive", "c:/foo"],
    ["unc backslash", "\\\\server\\share"],
    ["unc slash", "//server/share"],
    ["empty", ""],
    ["nul byte", "a\0b.map"],
    ["newline", "assets/a\nb.map"],
    ["carriage return", "assets/a\rb.map"],
    ["tab", "assets/a\tb.map"],
    ["del char", "assets/ab.map"],
    ["reserved NUL", "NUL"],
    ["reserved nul with ext", "assets/nul.map"],
    ["reserved CON", "CON.js"],
    ["reserved AUX", "aux"],
    ["reserved COM1", "COM1.map"],
    ["reserved LPT9", "lpt9.js"],
    ["trailing slash", "assets/"],
    ["leading slash after sep", "/assets/app.js.map"],
    ["empty segment", "assets//app.js.map"],
    ["trailing dot segment", "assets/foo./app.js.map"],
    ["trailing space segment", "assets/foo /app.js.map"],
  ])("rejects %s (%s)", (_label, candidate) => {
    expect(() => canonicalizeArtifactPath(candidate)).toThrow(
      ArtifactPathError,
    );
  });

  it.each([
    ["encoded dotdot", "%2e%2e/foo"],
    ["encoded dotdot slash", "..%2ffoo"],
    ["encoded slash traversal", "foo/%2e%2e/bar"],
    ["double-encoded dotdot", "%252e%252e/foo"],
    ["encoded backslash traversal", "%5c..%5cfoo"],
    ["encoded absolute", "%2fetc%2fpasswd"],
    ["encoded drive", "%43%3a/foo"],
    ["encoded NUL", "a%00b.map"],
    ["encoded newline", "a%0ab.map"],
  ])("rejects %s (%s)", (_label, candidate) => {
    expect(() => canonicalizeArtifactPath(candidate)).toThrow(
      ArtifactPathError,
    );
  });

  it("rejects non-string input", () => {
    expect(() => canonicalizeArtifactPath(undefined)).toThrow(
      ArtifactPathError,
    );
    expect(() => canonicalizeArtifactPath(null)).toThrow(ArtifactPathError);
    expect(() => canonicalizeArtifactPath(42)).toThrow(ArtifactPathError);
    expect(() => canonicalizeArtifactPath({})).toThrow(ArtifactPathError);
  });

  it("rejects over-long paths and segments", () => {
    expect(() => canonicalizeArtifactPath(`a${"x".repeat(1024)}`)).toThrow(
      ArtifactPathError,
    );
    expect(() => canonicalizeArtifactPath(`${"s".repeat(256)}.map`)).toThrow(
      ArtifactPathError,
    );
  });

  it("keeps literal percent sequences that decode to safe paths", () => {
    // "100%.map" is not valid percent-encoding (lone %), so it stays
    // literal — and the literal form is a safe relative path.
    expect(canonicalizeArtifactPath("100%.map")).toBe("100%.map");
  });

  it("proves containment when an upload root is given", () => {
    const root =
      process.platform === "win32" ? "C:\\upload-root" : "/upload-root";
    expect(
      canonicalizeArtifactPath("dist\\assets\\app.js.map", {
        uploadRoot: root,
      }),
    ).toBe("dist/assets/app.js.map");
    expect(() =>
      canonicalizeArtifactPath("../escape.map", { uploadRoot: root }),
    ).toThrow(ArtifactPathError);
  });
});

describe("resolveArtifactUploadPath", () => {
  const root =
    process.platform === "win32" ? "C:\\upload-root" : "/upload-root";

  it("joins canonical paths inside the root", () => {
    const resolved = resolveArtifactUploadPath(root, "assets/app.js.map");
    expect(resolved.startsWith(`${root}${sep()}`)).toBe(true);
    expect(resolved.endsWith(`assets${sep()}app.js.map`)).toBe(true);
  });

  it("rejects non-canonical input even when it looks containable", () => {
    for (const candidate of ["../evil.map", "/abs.map", "C:/x.map", ""]) {
      expect(() => resolveArtifactUploadPath(root, candidate)).toThrow(
        ArtifactPathError,
      );
    }
  });
});

describe("assertNoSymlinkEscape", () => {
  it("accepts real files and fresh paths under the root", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "rs06-symlink-ok-"));
    try {
      await mkdir(join(root, "safe"), { recursive: true });
      await writeFile(join(root, "safe", "app.js.map"), "{}");
      await assertNoSymlinkEscape(root, "safe/app.js.map");
      // Fresh target: no ancestor except the root exists yet.
      await assertNoSymlinkEscape(root, "fresh/nested/app.js.map");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects paths that traverse a planted symlink outside the root", async () => {
    const { mkdtemp, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "rs06-symlink-root-"));
    const outside = await mkdtemp(join(tmpdir(), "rs06-symlink-out-"));
    try {
      // Directory junctions need no privileges on Windows; both resolve
      // through realpath exactly like symlinks for containment purposes.
      await symlink(outside, join(root, "link"), "junction");
      await expect(
        assertNoSymlinkEscape(root, "link/evil.map"),
      ).rejects.toThrow(ArtifactPathError);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects dangling symlinks fail-closed", async () => {
    const { mkdtemp, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "rs06-symlink-dangle-"));
    try {
      await symlink(
        join(root, "does-not-exist"),
        join(root, "dangling"),
        "junction",
      );
      await expect(
        assertNoSymlinkEscape(root, "dangling/evil.map"),
      ).rejects.toThrow(ArtifactPathError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
