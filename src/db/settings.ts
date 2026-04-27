import { Knex } from "knex";

// The settings table is constrained to a single row keyed at id=1; the
// migration creates and seeds it, so reads can assume the row exists. Keep
// this typed (unlike the loose app_settings k/v store) so adding new columns
// stays a schema change rather than a stringly-typed lookup.
//
// Token caps (Phase 12): NULL means "unlimited". This is preserved through
// reads, writes, and JSON serialization so callers can branch on `cap === null`
// without an in-band sentinel.
export interface Settings {
  id: number;
  default_model: string;
  weekly_token_cap: number | null;
  session_token_cap: number | null;
  updated_at: Date | string;
}

const SETTINGS_ID = 1;

export type SettingsPatch = Partial<
  Pick<Settings, "default_model" | "weekly_token_cap" | "session_token_cap">
>;

export async function getSettings(db: Knex): Promise<Settings> {
  const row = await db<Settings>("settings").where({ id: SETTINGS_ID }).first();
  if (!row) {
    throw new Error("settings row missing — migration did not seed id=1");
  }
  return {
    ...row,
    weekly_token_cap: normalizeCap(row.weekly_token_cap),
    session_token_cap: normalizeCap(row.session_token_cap),
  };
}

export async function updateSettings(
  db: Knex,
  patch: SettingsPatch
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

// Returns null when the cap is unlimited. Callers that need a numeric ceiling
// must explicitly handle the null case rather than receiving Infinity or 0.
export async function getWeeklyTokenCap(db: Knex): Promise<number | null> {
  const settings = await getSettings(db);
  return settings.weekly_token_cap;
}

// Pass null to clear the cap (treated as unlimited). Negative values are
// rejected because they have no meaningful interpretation as a token budget.
export async function setWeeklyTokenCap(
  db: Knex,
  cap: number | null
): Promise<Settings> {
  validateCap(cap, "weekly_token_cap");
  return updateSettings(db, { weekly_token_cap: cap });
}

export async function getSessionTokenCap(db: Knex): Promise<number | null> {
  const settings = await getSettings(db);
  return settings.session_token_cap;
}

export async function setSessionTokenCap(
  db: Knex,
  cap: number | null
): Promise<Settings> {
  validateCap(cap, "session_token_cap");
  return updateSettings(db, { session_token_cap: cap });
}

// SQLite returns BIGINT columns as either a number or (for very large values)
// a string. Coerce to number | null so callers see a single shape. Undefined
// is normalized to null because the column is nullable and "not set" should
// flow through as the unlimited signal.
function normalizeCap(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function validateCap(cap: number | null, field: string): void {
  if (cap === null) return;
  if (!Number.isFinite(cap) || !Number.isInteger(cap) || cap < 0) {
    throw new Error(`${field} must be a non-negative integer or null`);
  }
}
