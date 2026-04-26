import { Knex } from "knex";

interface AppSettingRow {
  key: string;
  value: string;
  updated_at: Date | string;
}

// Generic key/value setting store. Used by the pull worker (and any future
// runtime-toggle features) to persist a flag that survives restarts without
// requiring a dedicated table per feature.
export async function getSetting(
  db: Knex,
  key: string
): Promise<string | undefined> {
  const row = await db<AppSettingRow>("app_settings").where({ key }).first();
  return row?.value;
}

export async function setSetting(
  db: Knex,
  key: string,
  value: string
): Promise<void> {
  const existing = await db<AppSettingRow>("app_settings").where({ key }).first();
  if (existing) {
    await db<AppSettingRow>("app_settings")
      .where({ key })
      .update({ value, updated_at: db.fn.now() });
  } else {
    await db<AppSettingRow>("app_settings").insert({ key, value });
  }
}

export const PULL_WORKER_PAUSED_KEY = "pull_worker_paused";

export async function isPullWorkerPaused(db: Knex): Promise<boolean> {
  const value = await getSetting(db, PULL_WORKER_PAUSED_KEY);
  return value === "true";
}

export async function setPullWorkerPaused(
  db: Knex,
  paused: boolean
): Promise<void> {
  await setSetting(db, PULL_WORKER_PAUSED_KEY, paused ? "true" : "false");
}
