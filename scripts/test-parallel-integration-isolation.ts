import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commands = [
  [
    "@replaybug/cli",
    "src/cli.integration.test.ts",
    "projects info succeeds with a token and fails without one",
  ],
  [
    "@replaybug/api",
    "src/routes/metrics.integration.test.ts",
    "project metrics integration",
  ],
] as const;

const inheritedEnv = { ...process.env };
const secrets = Object.entries(inheritedEnv)
  .filter(
    ([key, value]) => value && /(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
  )
  .map(([, value]) => value as string)
  .filter((value) => value.length > 0);
const redact = (output: string): string =>
  secrets.reduce(
    (safe, secret) => safe.replaceAll(secret, "[REDACTED]"),
    output,
  );

function runPnpmCommand(label: string, args: string[]): Promise<number> {
  const shellArgs =
    process.platform === "win32"
      ? args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`)
      : args;
  const child = spawn(pnpm, shellArgs, {
    env: inheritedEnv,
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
  return new Promise((resolve) => {
    child.once("error", (error) => {
      process.stderr.write(`${label}: ${error.message}\n`);
      resolve(1);
    });
    child.once("close", (code, signal) => {
      process.stdout.write(redact(stdout));
      process.stderr.write(redact(stderr));
      resolve(signal === null ? (code ?? 1) : 1);
    });
  });
}

function runPackageTest(
  filter: string,
  file: string,
  testName: string,
): Promise<number> {
  return runPnpmCommand(filter, [
    "--filter",
    filter,
    "test",
    "--",
    file,
    "-t",
    testName,
  ]);
}

async function main(): Promise<void> {
  const prebuildCode = await runPnpmCommand("dependency build", [
    "turbo",
    "build",
    "--force",
    "--filter=@replaybug/api...",
    "--filter=@replaybug/cli...",
  ]);
  if (prebuildCode !== 0) {
    process.exitCode = 1;
    return;
  }

  const results = await Promise.all(
    commands.map(([filter, file, testName]) =>
      runPackageTest(filter, file, testName),
    ),
  );
  process.exitCode = results.every((code) => code === 0) ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "isolation harness failed",
  );
  process.exitCode = 1;
});
