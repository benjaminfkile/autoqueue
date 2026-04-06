import dotenv from "dotenv";
dotenv.config();

import http from "http";
import app from "./src/app";
import { getAppSecrets } from "./src/aws/getAppSecrets";
import { getDBSecrets } from "./src/aws/getDBSecrets";
import { initDb, getDb } from "./src/db/db";
import { syncWebhooks, recoverQueues } from "./src/services/queue";
import morgan from "morgan";

process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  console.log("Node NOT Exiting...");
});

async function start() {
  try {
    const appSecrets = await getAppSecrets();
    const dbSecrets = await getDBSecrets();

    console.log("App secrets", appSecrets);
    console.log("DB secrets", dbSecrets);

    app.set("secrets", appSecrets);

    const morganFormat =
      appSecrets.NODE_ENV === "production" ? "tiny" : "common";
    app.use(morgan(morganFormat));

    const port = parseInt(appSecrets.PORT) || 8000;

    await initDb(dbSecrets, appSecrets);
    await syncWebhooks(getDb(), appSecrets, appSecrets.BASE_URL);

    // Recover any queues that got stuck (missed webhooks, manual tasks, etc.)
    await recoverQueues(getDb(), appSecrets);

    // Periodically re-check for stuck queues every 5 minutes
    const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
    setInterval(async () => {
      try {
        await recoverQueues(getDb(), appSecrets);
      } catch (err) {
        console.error("[recoverQueues interval] Error:", err);
      }
    }, RECOVERY_INTERVAL_MS);

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
