import { Knex } from "knex";

// The settings table is constrained to a single row keyed at id=1; the
// migration creates and seeds it, so reads can assume the row exists. Keep
// this typed (unlike the loose app_settings k/v store) so adding new columns
// stays a schema change rather than a stringly-typed lookup.
export interface Settings {
  id: number;
  default_model: string;
  updated_at: Date | string;
}

const SETTINGS_ID = 1;

export async function getSettings(db: Knex): Promise<Settings> {
  const row = await db<Settings>("settings").where({ id: SETTINGS_ID }).first();
  if (!row) {
    throw new Error("settings row missing — migration did not seed id=1");
  }
  return row;
}

export async function updateSettings(
  db: Knex,
  patch: Partial<Pick<Settings, "default_model">>
): Promise<Settings> {
  await db<Settings>("settings")
    .where({ id: SETTINGS_ID })
    .update({ ...patch, updated_at: db.fn.now() });
  return getSettings(db);
}

export async function getDefaultModel(db: Knex): Promise<string> {
  const settings = await getSettings(db);
  return settings.default_model;
}

export async function setDefaultModel(
  db: Knex,
  model: string
): Promise<Settings> {
  return updateSettings(db, { default_model: model });
}
