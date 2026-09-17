import { loadApiConfigFromEnv } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadApiConfigFromEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const app = await buildApp({ config });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error({ err: error }, "Failed to start ReplayBug API");
    process.exit(1);
  }
}

void main();
