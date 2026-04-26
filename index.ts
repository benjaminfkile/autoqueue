import dotenv from "dotenv";
dotenv.config();

import http from "http";
import fs from "fs";
import app from "./src/app";
import { IAppSecrets } from "./src/interfaces";
import { initDb, getDb } from "./src/db/db";
import { reconcileOrphanedTasks } from "./src/db/tasks";
import { startScheduler, WORKER_ID } from "./src/services/scheduler";
import * as secrets from "./src/secrets";
import morgan from "morgan";

process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  console.log("Node NOT Exiting...");
});

// Non-secret runtime config. Real secrets (ANTHROPIC_API_KEY, GH_PAT) live in
// the encrypted secrets store and are fetched on demand by the modules that
// need them — they do not get attached to the express app.
function loadAppConfig(): IAppSecrets {
  const nodeEnv =
    process.env.NODE_ENV === "production" ? "production" : "development";
  return {
    NODE_ENV: nodeEnv,
    PORT: process.env.PORT ?? "8000",
    API_KEY_HASH: process.env.API_KEY_HASH ?? "",
    REPOS_PATH: process.env.REPOS_PATH ?? "",
    POLL_INTERVAL_SECONDS: process.env.POLL_INTERVAL_SECONDS,
    CLAUDE_PATH: process.env.CLAUDE_PATH,
    IS_WORKER: process.env.IS_WORKER,
  };
}

// Initialize the encrypted secrets store. On a fresh install this generates
// (or prompts for) the encryption key and writes an empty secrets file. If
// neither path can succeed — no OS keychain available, no TTY for a passphrase
// prompt, no GRUNT_MASTER_KEY set — bail with an actionable setup prompt
// rather than crashing the user with a stack trace.
function initSecretsStoreOrExit(): void {
  try {
    secrets.init();
  } catch (err) {
    const message = (err as Error).message;
    console.error("[startup] Could not initialize the encrypted secrets store.");
    console.error(`          ${message}`);
    console.error(
      "          Setup required: store a passphrase via GRUNT_MASTER_KEY (headless"
    );
    console.error(
      "          environments) or run grunt from a terminal so it can prompt for one."
    );
    console.error(
      `          Secrets file: ${secrets.getSecretsFilePath()}`
    );
    process.exit(1);
  }
}

async function start() {
  try {
    initSecretsStoreOrExit();

    const appConfig = loadAppConfig();

    const morganFormat =
      appConfig.NODE_ENV === "production" ? "tiny" : "common";
    app.use(morgan(morganFormat));

    const port = parseInt(appConfig.PORT) || 8000;

    await initDb(appConfig);

    const reposPath = appConfig.REPOS_PATH;
    if (!fs.existsSync(reposPath)) {
      fs.mkdirSync(reposPath, { recursive: true });
      console.log(`Created repos directory: ${reposPath}`);
    }

    const reclaimedCount = await reconcileOrphanedTasks(getDb(), WORKER_ID);
    console.log(
      `[startup] Reclaimed ${reclaimedCount} orphaned task(s) back to pending (worker_id=${WORKER_ID}).`
    );

    startScheduler(getDb(), appConfig);

    const server = http.createServer(app);

    process.on("SIGINT", () => {
      server.close(() => {
        console.log("Server closed (SIGINT)");
        process.exit(0);
      });
    });

    process.on("SIGTERM", () => {
      server.close(() => {
        console.log("Server closed (SIGTERM)");
        process.exit(0);
      });
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`⚡️[server]: Running at http://127.0.0.1:${port}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
