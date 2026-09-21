import { spawn } from "node:child_process";
import { createIsolatedTestDatabase } from "../packages/db/src/test-support/isolated-test-database.js";

async function main(): Promise<void> {
  const suite = process.argv[2];
  const vitestArgs = process.argv
    .slice(3)
    .filter((arg, index) => !(index === 0 && arg === "--"));
  if (suite === undefined) {
    console.error(
      "Usage: run-isolated-vitest.ts <suite> [vitest arguments...]",
    );
    process.exitCode = 2;
    return;
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const inheritedEnv = { ...process.env };
  const secrets = Object.entries(inheritedEnv)
    .filter(
      ([key, value]) =>
        value && /(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
    )
    .map(([, value]) => value as string)
    .filter((value) => value.length > 0);
  const redact = (output: string): string =>
    secrets.reduce(
      (safe, secret) => safe.replaceAll(secret, "[REDACTED]"),
      output,
    );

  let cleanup: (() => Promise<void>) | undefined;
  try {
    const isolated = await createIsolatedTestDatabase({ suite });
    cleanup = isolated.cleanup;
    const childEnv: NodeJS.ProcessEnv = {
      ...inheritedEnv,
      REPLAYBUG_DATABASE_URL: isolated.databaseUrl,
    };
    delete childEnv["REPLAYBUG_AUTH_TOKEN"];

    const childArgs = ["exec", "vitest", "run", ...vitestArgs];
    const shellArgs =
      process.platform === "win32"
        ? childArgs.map((arg) => `"${arg.replaceAll('"', '\\"')}"`)
        : childArgs;
    const child = spawn(pnpm, shellArgs, {
      env: childEnv,
      shell: process.platform === "win32",
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve(signal === null ? (code ?? 1) : 1),
      );
    });
    process.stdout.write(redact(stdout));
    process.stderr.write(redact(stderr));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "isolated test runner failed",
    );
    process.exitCode = 1;
  } finally {
    if (cleanup) await cleanup();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "isolated test runner failed",
  );
  process.exitCode = 1;
});
