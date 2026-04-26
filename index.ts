import dotenv from "dotenv";
dotenv.config();

import http from "http";
import fs from "fs";
import app from "./src/app";
import { IAppSecrets } from "./src/interfaces";
import { initDb, getDb } from "./src/db/db";
import { reconcileOrphanedTasks } from "./src/db/tasks";
import { startScheduler, WORKER_ID } from "./src/services/scheduler";
import morgan from "morgan";

process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  console.log("Node NOT Exiting...");
});

// Placeholder until the Phase 3 secrets module lands. Reads the same fields
// from process.env that getAppSecrets used to fetch from AWS Secrets Manager.
function loadAppSecrets(): IAppSecrets {
  const nodeEnv =
    process.env.NODE_ENV === "production" ? "production" : "development";
  return {
    NODE_ENV: nodeEnv,
    PORT: process.env.PORT ?? "8000",
    API_KEY_HASH: process.env.API_KEY_HASH ?? "",
    GH_PAT: process.env.GH_PAT,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    REPOS_PATH: process.env.REPOS_PATH ?? "",
    POLL_INTERVAL_SECONDS: process.env.POLL_INTERVAL_SECONDS,
    CLAUDE_PATH: process.env.CLAUDE_PATH,
    IS_WORKER: process.env.IS_WORKER,
  };
}

async function start() {
  try {
    const appSecrets = loadAppSecrets();

    app.set("secrets", appSecrets);

    const morganFormat =
      appSecrets.NODE_ENV === "production" ? "tiny" : "common";
    app.use(morgan(morganFormat));

    const port = parseInt(appSecrets.PORT) || 8000;

    await initDb(appSecrets);

    const reposPath = appSecrets.REPOS_PATH;
    if (!fs.existsSync(reposPath)) {
      fs.mkdirSync(reposPath, { recursive: true });
      console.log(`Created repos directory: ${reposPath}`);
    }

    const reclaimedCount = await reconcileOrphanedTasks(getDb(), WORKER_ID);
    console.log(
      `[startup] Reclaimed ${reclaimedCount} orphaned task(s) back to pending (worker_id=${WORKER_ID}).`
    );

    startScheduler(getDb(), appSecrets);

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
