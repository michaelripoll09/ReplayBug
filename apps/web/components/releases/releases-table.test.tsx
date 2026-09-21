import { describe, expect, it, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ReleasesTable, type ReleaseListItem } from "./releases-table";
import {
  ReleaseArtifactsTable,
  type ReleaseArtifactItem,
} from "./release-artifacts-table";

// Explicit unmount between tests: this vitest setup has no testing-library
// auto-cleanup (no globals).
afterEach(() => {
  cleanup();
});

const ITEMS: ReleaseListItem[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    version: "web@1.4.2",
    commitSha: "abc1234def",
    createdAt: "2026-09-18T12:00:00.000Z",
    artifactCount: 2,
    sourceMapCount: 1,
    minifiedAssetCount: 1,
    occurrenceCount: 3,
    hasSourceMaps: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    version: "web@1.4.3",
    commitSha: null,
    createdAt: "2026-09-18T13:00:00.000Z",
    artifactCount: 0,
    sourceMapCount: 0,
    minifiedAssetCount: 0,
    occurrenceCount: 1,
    hasSourceMaps: false,
  },
];

const ARTIFACTS: ReleaseArtifactItem[] = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    artifactPath: "assets/app.js.map",
    artifactType: "source_map",
    contentHash: "a".repeat(64),
    sizeBytes: 1536,
    createdAt: "2026-09-18T12:00:00.000Z",
  },
  {
    id: "44444444-4444-4344-8344-444444444444",
    artifactPath: "assets/app.js",
    artifactType: "minified_asset",
    contentHash: "b".repeat(64),
    sizeBytes: 512,
    createdAt: "2026-09-18T12:00:00.000Z",
  },
];

/**
 * RS-10 releases dashboard: version/commit/created/occurrences plus
 * source-map and artifact counts; detail lists artifact paths + status as
 * escaped text (never map contents, never storage keys).
 */
describe("releases table", () => {
  it("renders versions, commits, counts and detail links", () => {
    render(<ReleasesTable projectId="proj-1" items={ITEMS} />);
    expect(screen.getByText("web@1.4.2")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1 mapped")).toBeInTheDocument();
    expect(screen.getByText("No maps")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "web@1.4.2" });
    expect(link).toHaveAttribute(
      "href",
      "/app/projects/proj-1/releases/11111111-1111-4111-8111-111111111111",
    );
  });

  it("shows an empty state when no releases exist", () => {
    render(<ReleasesTable projectId="proj-1" items={[]} />);
    expect(screen.getByText("No releases yet")).toBeInTheDocument();
  });

  it("renders hostile versions as inert text", () => {
    const hostile: ReleaseListItem = {
      ...ITEMS[0]!,
      version: "</code><script>alert(1)</script>",
    };
    const { container } = render(
      <ReleasesTable projectId="proj-1" items={[hostile]} />,
    );
    expect(container.querySelector("script")).toBeNull();
    const hits = screen.getAllByText(
      (_, el) => el?.textContent?.includes("alert(1)") ?? false,
    );
    expect(hits.find((el) => el.children.length === 0)?.textContent).toContain(
      "alert(1)",
    );
  });
});

describe("release artifacts table", () => {
  it("lists artifact paths, types, status and hashes without storage keys", () => {
    const { container } = render(
      <ReleaseArtifactsTable artifacts={ARTIFACTS} />,
    );
    expect(screen.getByText("assets/app.js.map")).toBeInTheDocument();
    expect(screen.getByText("Source map")).toBeInTheDocument();
    expect(screen.getByText("Minified asset")).toBeInTheDocument();
    expect(screen.getAllByText("Stored")).toHaveLength(2);
    expect(screen.getByText("1.5 KiB")).toBeInTheDocument();
    // No artifact bytes, no navigation to local paths, no storage keys.
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/storage/i);
  });

  it("shows an empty state when no artifacts were uploaded", () => {
    render(<ReleaseArtifactsTable artifacts={[]} />);
    expect(screen.getByText("No artifacts uploaded")).toBeInTheDocument();
  });

  it("renders hostile artifact paths as inert text", () => {
    const hostile: ReleaseArtifactItem = {
      ...ARTIFACTS[0]!,
      artifactPath: "</code><script>alert(1)</script>.map",
    };
    const { container } = render(
      <ReleaseArtifactsTable artifacts={[hostile]} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    const hits = screen.getAllByText(
      (_, el) => el?.textContent?.includes("alert(1)") ?? false,
    );
    expect(hits.find((el) => el.children.length === 0)?.textContent).toContain(
      "alert(1)",
    );
  });
});
