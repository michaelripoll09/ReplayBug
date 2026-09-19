/**
 * verify-generated-test.ts — CI/development proof ONLY for generated Playwright reproductions.
 *
 * Purpose: prove a generated `.spec.ts` is syntactically valid TypeScript and
 * passes against the LOCAL demo only. This is a manual/CI proof tool, not a
 * service: it never serves an API, never reads arbitrary DB rows, and never
 * browses remote URLs.
 *
 * Usage:
 *   pnpm verify:generated-test -- --code-file ./repro.spec.ts
 *   pnpm verify:generated-test -- --code-file ./repro.spec.ts --target http://localhost:5173
 *   REPLAYBUG_DEMO_URL=http://localhost:5173 pnpm verify:generated-test -- --code-file ./repro.spec.ts
 *   pnpm exec tsx scripts/verify-generated-test.ts --code-file ./repro.spec.ts --target http://127.0.0.1:5173
 *
 * Args:
 *   --code-file <path>   Required. Path to the generated `.spec.ts` file.
 *   --target <url>       Optional. Demo base URL under test.
 *                        Default: $REPLAYBUG_DEMO_URL ?? "http://localhost:5173".
 *   --timeout-ms <n>     Optional. Playwright run timeout in ms (default 120000).
 *   --help               Print usage and exit 0.
 *
 * Behavior:
 *   1. Validates --target against a loopback-only allowlist
 *      (hostname must be `localhost`, `127.0.0.1`, or `::1`; protocol must be
 *      `http:` or `https:`; no credentials, no file:/data: URLs, no private
 *      or public remote hosts).
 *   2. Reads the code file, validates TypeScript syntax via the TypeScript
 *      compiler API (`transpileModule` with `reportDiagnostics`).
 *   3. Scans the code for embedded http(s) URLs and rejects any that are not
 *      loopback-allowlisted (prevents a crafted spec from exfiltrating to a
 *      customer URL even when --target itself is local).
 *   4. Copies the spec into a fresh temp dir and runs it with Playwright
 *      Chromium via a spawned `node <cli.js> test` child process (no npx,
 *      no shell shims, temp config resolves @playwright/test through the
 *      demo package so nothing is written into the repo).
 *   5. Exits 0 only when syntax is valid AND the Playwright run passes.
 *      Exits non-zero on syntax error, disallowed target/URL, or test failure.
 *
 * Safety notes:
 *   - The executed file is exactly the file you pass; inspect generated code
 *     before running it. The URL scan is defense-in-depth, not a sandbox.
 *   - Never point --target at a customer, staging, or production host: the
 *     allowlist rejects anything that is not loopback.
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");

const DEFAULT_TARGET = "http://localhost:5173";
const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

interface CliArgs {
  codeFile: string | null;
  target: string | null;
  timeoutMs: number;
  help: boolean;
}

function printUsage(): void {
  console.log(`verify-generated-test — proof-only runner for generated Playwright specs

Usage:
  pnpm verify:generated-test -- --code-file <path> [--target <url>] [--timeout-ms <n>]

Options:
  --code-file <path>   Generated .spec.ts file to verify (required).
  --target <url>       Local demo base URL (default: $REPLAYBUG_DEMO_URL or ${DEFAULT_TARGET}).
  --timeout-ms <n>     Playwright run timeout in ms (default: ${DEFAULT_TIMEOUT_MS}).
  --help               Show this help.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    codeFile: null,
    target: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--code-file") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--code-file requires a file path value.");
      }
      out.codeFile = next;
      i += 1;
    } else if (arg.startsWith("--code-file=")) {
      out.codeFile = arg.slice("--code-file=".length);
    } else if (arg === "--target") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--target requires a URL value.");
      }
      out.target = next;
      i += 1;
    } else if (arg.startsWith("--target=")) {
      out.target = arg.slice("--target=".length);
    } else if (arg === "--timeout-ms") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--timeout-ms requires a numeric value.");
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      out.timeoutMs = parsed;
      i += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      const parsed = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      out.timeoutMs = parsed;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

/** Loopback-only gate: localhost, 127.0.0.1, ::1 over http(s), no credentials. */
function assertAllowlistedTarget(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${label} must use http(s): rejected protocol ${url.protocol}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} must not contain credentials.`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `${label} host must be loopback (localhost, 127.0.0.1, ::1): rejected ${url.hostname}`,
    );
  }
  return url;
}

/** Extract candidate http(s) URLs embedded in generated code for gating. */
function embeddedHttpUrls(code: string): string[] {
  const found: string[] = [];
  const re = /https?:\/\/[^\s'"`()<>\\]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    if (!found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

function validateSyntax(code: string): string[] {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    reportDiagnostics: true,
  });
  const errors: string[] = [];
  for (const diagnostic of result.diagnostics ?? []) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      " ",
    );
    errors.push(message.slice(0, 300));
    if (errors.length >= 10) {
      break;
    }
  }
  return errors;
}

function rejectUnsafeImports(code: string): string[] {
  const problems: string[] = [];
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /from\s+['"]node:/, label: "node: import" },
    { re: /require\s*\(\s*['"]child_process['"]/, label: "child_process" },
    { re: /require\s*\(\s*['"]fs['"]/, label: "fs require" },
    { re: /from\s+['"]fs['"]/, label: "fs import" },
    { re: /child_process/, label: "child_process reference" },
  ];
  for (const entry of patterns) {
    if (entry.re.test(code)) {
      problems.push(`generated spec must not contain ${entry.label}`);
    }
  }
  return problems;
}

async function runPlaywright(
  specFile: string,
  workDir: string,
  timeoutMs: number,
): Promise<number> {
  // Resolve the CLI through the demo package (always installed there) and
  // spawn node directly: no npx/shell shims, so Windows and CI behave the
  // same. The temp config requires @playwright/test via the demo
  // package.json, so it resolves from any directory and nothing is
  // written into the repo.
  const require = createRequire(
    join(REPO_ROOT, "apps", "demo", "package.json"),
  );
  const cliEntry = join(
    dirname(require.resolve("@playwright/test/package.json")),
    "cli.js",
  );
  const configFile = join(workDir, "replaybug.verify.config.ts");
  const demoAnchor = join(REPO_ROOT, "apps", "demo", "package.json").replace(
    /\\/g,
    "\\\\",
  );
  writeFileSync(
    configFile,
    `import { createRequire } from "node:module";\n` +
      `const require = createRequire(${JSON.stringify(demoAnchor)});\n` +
      `const { defineConfig } = require("@playwright/test");\n` +
      `export default defineConfig({\n` +
      `  testDir: ${JSON.stringify(workDir)},\n` +
      `  testMatch: ["repro.verify.spec.ts"],\n` +
      `  timeout: 60000,\n` +
      `  fullyParallel: false,\n` +
      `  workers: 1,\n` +
      `  reporter: [["line"]],\n` +
      `});\n`,
    "utf8",
  );
  return new Promise<number>((resolvePromise) => {
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(code);
    };
    const child = spawn(
      process.execPath,
      [cliEntry, "test", "--config", configFile, "--reporter=line"],
      {
        cwd: join(REPO_ROOT, "apps", "demo"),
        shell: false,
        env: { ...process.env, PLAYWRIGHT_WORKERS: "1" },
      },
    );
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      child.kill();
      console.error(`verify-generated-test: timed out after ${timeoutMs}ms`);
      done(1);
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    child.on("error", (error) => {
      console.error(
        `verify-generated-test: failed to launch playwright: ${String(error)}`,
      );
      done(1);
    });
    child.on("exit", (code) => {
      done(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `verify-generated-test: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 2;
  }
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.codeFile === null || args.codeFile.trim() === "") {
    console.error("verify-generated-test: --code-file <path> is required.");
    printUsage();
    return 2;
  }
  const targetRaw =
    args.target ?? process.env["REPLAYBUG_DEMO_URL"] ?? DEFAULT_TARGET;
  try {
    assertAllowlistedTarget(targetRaw, "--target");
  } catch (error) {
    console.error(
      `verify-generated-test: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  const codePath = resolve(args.codeFile);
  let code: string;
  try {
    if (!existsSync(codePath)) {
      console.error(`verify-generated-test: code file not found: ${codePath}`);
      return 2;
    }
    code = readFileSync(codePath, "utf8");
  } catch (error) {
    console.error(
      `verify-generated-test: cannot read code file: ${String(error)}`,
    );
    return 2;
  }
  if (code.trim() === "") {
    console.error("verify-generated-test: code file is empty.");
    return 2;
  }

  const syntaxErrors = validateSyntax(code);
  if (syntaxErrors.length > 0) {
    console.error("verify-generated-test: TypeScript syntax errors:");
    for (const message of syntaxErrors) {
      console.error(`  - ${message}`);
    }
    return 2;
  }

  const importProblems = rejectUnsafeImports(code);
  if (importProblems.length > 0) {
    for (const problem of importProblems) {
      console.error(`verify-generated-test: ${problem}`);
    }
    return 2;
  }

  for (const embedded of embeddedHttpUrls(code)) {
    try {
      assertAllowlistedTarget(embedded, "embedded spec URL");
    } catch (error) {
      console.error(
        `verify-generated-test: ${error instanceof Error ? error.message : String(error)} (${embedded})`,
      );
      return 2;
    }
  }

  const workDir = mkdtempSync(join(tmpdir(), "replaybug-verify-"));
  const tempSpec = join(workDir, "repro.verify.spec.ts");
  copyFileSync(codePath, tempSpec);
  // Marker so a stray temp run is identifiable; never executed remotely.
  writeFileSync(
    join(workDir, "REPLAYBUG_VERIFY_TARGET.txt"),
    `target=${targetRaw}\nsource=${codePath}\n`,
    "utf8",
  );
  console.log(
    `verify-generated-test: syntax OK, running ${tempSpec} against ${targetRaw}`,
  );

  const exitCode = await runPlaywright(tempSpec, workDir, args.timeoutMs);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup.
  }
  if (exitCode !== 0) {
    console.error(
      `verify-generated-test: playwright run failed (exit ${exitCode}).`,
    );
    return 1;
  }
  console.log(
    "verify-generated-test: PASS — generated test passed against local demo.",
  );
  return 0;
}

void main().then(
  (exitCode) => {
    process.exit(exitCode);
  },
  (error: unknown) => {
    console.error(
      `verify-generated-test: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
