import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import health from "./health";

const APP_NAME = "grunt";

let db: Knex | null = null;

function getUserDataDir(appName: string): string {
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  const base =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, appName);
}

export function getDbFilePath(): string {
  return path.join(getUserDataDir(APP_NAME), "grunt.sqlite");
}

export async function initDb(_appSecrets: IAppSecrets): Promise<Knex> {
  if (db) return db;

  const dbFile = getDbFilePath();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  db = knex({
    client: "better-sqlite3",
    connection: {
      filename: dbFile,
    },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn: any, done: (err: Error | null, conn: any) => void) => {
        try {
          conn.pragma("journal_mode = WAL");
          conn.pragma("foreign_keys = ON");
          done(null, conn);
        } catch (err) {
          done(err as Error, conn);
        }
      },
    },
    migrations: {
      directory: path.join(__dirname, "migrations"),
      extension: "js",
    },
  });

  const dbHealth = await health.getDBConnectionHealth(db, true);
  console.log(dbHealth.logs);

  await db.migrate.latest();
  console.log("Database migrations applied.");

  return db;
}

export function getDb(): Knex {
  if (!db) {
    throw new Error("Database has not been initialized. Call initDb() first.");
  }
  return db;
}
