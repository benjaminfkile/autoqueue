import path from "path";
import knex, { Knex } from "knex";
import { IAppSecrets, IDBSecrets } from "../interfaces";
import health from "./health";

let db: Knex | null = null;

export async function initDb(
  dbSecrets: IDBSecrets,
  appSecrets: IAppSecrets
): Promise<Knex> {
  if (db) return db;

  const { DB_NAME, DB_HOST } = appSecrets;

  // const dbUrl = DB_PROXY_URL; // enable when RDS proxy is in use
  const dbUrl = DB_HOST;

  db = knex({
    client: "pg",
    connection: {
      host: dbUrl,
      user: dbSecrets.username,
      password: dbSecrets.password,
      database: DB_NAME,
      port: 5432,
      ssl: { rejectUnauthorized: false },
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
