"use client";

import * as React from "react";

export type StackSymbolicationStatus =
  | "mapped"
  | "partially_mapped"
  | "no_release"
  | "release_not_found"
  | "map_not_found"
  | "invalid_map"
  | "storage_unavailable";

const STATUSES: readonly StackSymbolicationStatus[] = [
  "mapped",
  "partially_mapped",
  "no_release",
  "release_not_found",
  "map_not_found",
  "invalid_map",
  "storage_unavailable",
];

export interface RawStackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
}

export interface MappedStackFrame {
  filename: string;
  source: string;
  function: string;
  name: string | null;
  line: number;
  column: number;
  inApplication: boolean;
  mapped: boolean;
}

export interface StackDiagnostic {
  symbolicationStatus: StackSymbolicationStatus | null;
  rawFrames: RawStackFrame[];
  mappedFrames: MappedStackFrame[] | null;
}

export interface ExceptionStackValue {
  type: string;
  value: string;
  stacktrace?: { frames: RawStackFrame[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function cleanRawFrame(value: unknown): RawStackFrame | null {
  if (!isRecord(value)) {
    return null;
  }
  const frame: RawStackFrame = {};
  const filename = optString(value["filename"]);
  if (filename !== undefined) {
    frame.filename = filename;
  }
  const fn = optString(value["function"]);
  if (fn !== undefined) {
    frame.function = fn;
  }
  const lineno = optNonNegativeInt(value["lineno"]);
  if (lineno !== undefined) {
    frame.lineno = lineno;
  }
  const colno = optNonNegativeInt(value["colno"]);
  if (colno !== undefined) {
    frame.colno = colno;
  }
  if (typeof value["inApp"] === "boolean") {
    frame.inApp = value["inApp"];
  } else if (typeof value["in_app"] === "boolean") {
    frame.inApp = value["in_app"];
  }
  return frame;
}

function cleanMappedFrame(value: unknown): MappedStackFrame | null {
  if (!isRecord(value)) {
    return null;
  }
  const filename = optString(value["filename"]);
  const source = optString(value["source"]);
  const fn = optString(value["function"]);
  const line = optNonNegativeInt(value["line"]);
  const column = optNonNegativeInt(value["column"]);
  if (
    filename === undefined ||
    source === undefined ||
    fn === undefined ||
    line === undefined ||
    column === undefined ||
    typeof value["inApplication"] !== "boolean" ||
    typeof value["mapped"] !== "boolean"
  ) {
    return null;
  }
  const name = value["name"];
  return {
    filename,
    source,
    function: fn,
    name: name === null || typeof name === "string" ? name : null,
    line,
    column,
    inApplication: value["inApplication"],
    mapped: value["mapped"],
  };
}

/**
 * Validate an unknown event `diagnostic` payload into a `StackDiagnostic`.
 * Only allowlisted frame fields survive; anything else (including a
 * server-echoed `preferredStack`, extra DB keys, or malformed frames) is
 * dropped. Returns `null` when no usable diagnostic is present so callers
 * fall back to the ingested raw stack.
 */
export function toStackDiagnostic(value: unknown): StackDiagnostic | null {
  if (!isRecord(value)) {
    return null;
  }
  const statusRaw = value["symbolicationStatus"];
  const symbolicationStatus =
    statusRaw === null ||
    statusRaw === undefined ||
    (typeof statusRaw === "string" &&
      (STATUSES as readonly string[]).includes(statusRaw))
      ? ((statusRaw as StackSymbolicationStatus | null | undefined) ?? null)
      : null;
  const rawInput = value["rawFrames"];
  const rawFrames = Array.isArray(rawInput)
    ? rawInput.map(cleanRawFrame).filter((f): f is RawStackFrame => f !== null)
    : [];
  const mappedInput = value["mappedFrames"];
  const mappedFrames =
    mappedInput === null || mappedInput === undefined
      ? null
      : Array.isArray(mappedInput)
        ? mappedInput
            .map(cleanMappedFrame)
            .filter((f): f is MappedStackFrame => f !== null)
        : null;
  if (symbolicationStatus === null && rawFrames.length === 0) {
    return null;
  }
  return {
    symbolicationStatus,
    rawFrames,
    mappedFrames:
      mappedFrames !== null && mappedFrames.length > 0 ? mappedFrames : null,
  };
}

/** Honest per-status label rendered next to the raw stack. */
export function symbolicationStatusLabel(
  status: StackSymbolicationStatus | null,
): string {
  switch (status) {
    case "mapped":
      return "Source mapped";
    case "partially_mapped":
      return "Partially source mapped";
    case "no_release":
      return "No release recorded for this event";
    case "release_not_found":
      return "Release not registered";
    case "map_not_found":
      return "Source map unavailable";
    case "invalid_map":
      return "Source map invalid";
    case "storage_unavailable":
      return "Source map storage unavailable";
    case null:
      return "Source map unavailable";
  }
}

function formatRawFrame(frame: RawStackFrame): string {
  const loc =
    frame.filename !== undefined
      ? `${frame.filename}${frame.lineno !== undefined ? `:${frame.lineno}` : ""}${frame.colno !== undefined ? `:${frame.colno}` : ""}`
      : "<unknown>";
  return `${loc}${frame.inApp === false ? " [third-party]" : ""}`;
}

function formatMappedFrame(frame: MappedStackFrame): string {
  const fn =
    frame.name ?? (frame.function === "" ? "anonymous" : frame.function);
  return `${frame.source}:${frame.line}:${frame.column} ${fn}()`;
}

/**
 * Issue stack evidence with source-mapped-first rendering.
 *
 * Mapped frames available → default `Source mapped` view with an explicit
 * `Source mapped`/`Raw` toggle. No map → Raw view plus the honest persisted
 * status (Source map unavailable / No release / Release not registered /
 * …). Source-map `source` and function names are untrusted: every frame
 * renders as escaped monospace text — no links to local paths, no
 * dangerouslySetInnerHTML, no script-capable markup.
 */
export function StackView({
  values,
  diagnostic,
}: {
  values: ExceptionStackValue[];
  diagnostic: StackDiagnostic | null;
}): React.JSX.Element {
  const mapped = diagnostic?.mappedFrames ?? null;
  const [view, setView] = React.useState<"mapped" | "raw">(
    mapped !== null ? "mapped" : "raw",
  );
  const showingMapped = view === "mapped" && mapped !== null;
  const rawFrames = diagnostic?.rawFrames ?? [];
  const status = diagnostic?.symbolicationStatus ?? null;

  return (
    <div className="space-y-3">
      {mapped !== null ? (
        <div
          role="group"
          aria-label="Stack view"
          className="flex items-center gap-1"
        >
          <button
            type="button"
            aria-pressed={showingMapped}
            onClick={() => setView("mapped")}
            className={
              showingMapped
                ? "rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                : "rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800"
            }
          >
            Source mapped
          </button>
          <button
            type="button"
            aria-pressed={!showingMapped}
            onClick={() => setView("raw")}
            className={
              !showingMapped
                ? "rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                : "rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800"
            }
          >
            Raw
          </button>
          {status === "partially_mapped" ? (
            <span className="ml-2 text-xs text-zinc-500">
              Partially mapped — unmapped frames show generated locations.
            </span>
          ) : null}
        </div>
      ) : null}
      {showingMapped && mapped !== null ? (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            Source mapped stack trace — original locations.
          </p>
          {values.map((v, index) => (
            <div key={index}>
              <p className="text-sm font-medium">
                {v.type}: {v.value}
              </p>
              {mapped.length > 0 ? (
                <pre className="mt-1 overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
                  {mapped.map((frame, i) => (
                    <span key={i}>
                      {formatMappedFrame(frame)}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              ) : (
                <p className="mt-1 text-xs text-zinc-500">
                  No stack frames captured.
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            Raw stack trace — {symbolicationStatusLabel(status).toLowerCase()}.
          </p>
          {values.map((v, index) => {
            const frames =
              rawFrames.length > 0 ? rawFrames : (v.stacktrace?.frames ?? []);
            return (
              <div key={index}>
                <p className="text-sm font-medium">
                  {v.type}: {v.value}
                </p>
                {frames.length > 0 ? (
                  <pre className="mt-1 overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
                    {frames.map((frame, i) => (
                      <span key={i}>
                        {formatRawFrame(frame)}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="mt-1 text-xs text-zinc-500">
                    No stack frames captured.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
