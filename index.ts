import dotenv from "dotenv";
dotenv.config();

import http from "http";
import fs from "fs";
import app from "./src/app";
import { getAppSecrets } from "./src/aws/getAppSecrets";
import { getDBSecrets } from "./src/aws/getDBSecrets";
import { initDb, getDb } from "./src/db/db";
import { reconcileOrphanedTasks } from "./src/db/tasks";
import { startScheduler, WORKER_ID } from "./src/services/scheduler";
import morgan from "morgan";

process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  console.log("Node NOT Exiting...");
});

async function start() {
  try {
    const appSecrets = await getAppSecrets();
    const dbSecrets = await getDBSecrets();

    // console.log("App secrets", appSecrets);
    // console.log("DB secrets", dbSecrets);

    app.set("secrets", appSecrets);

    const morganFormat =
      appSecrets.NODE_ENV === "production" ? "tiny" : "common";
    app.use(morgan(morganFormat));

    const port = parseInt(appSecrets.PORT) || 8000;

    await initDb(dbSecrets, appSecrets);

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

    server.listen(port, () => {
      console.log(`⚡️[server]: Running at http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
