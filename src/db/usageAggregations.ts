import { Knex } from "knex";
import { TaskUsage } from "../interfaces";

// Token totals across the trailing 7-day window. Mirrors the four columns in
// task_usage and exposes a precomputed `total` so callers comparing against
// settings.weekly_token_cap don't have to reduce the breakdown themselves.
export interface WeeklyTokens {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  total: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Sums every task_usage row whose created_at falls in [now - 7d, ∞). The
// caller passes `now` explicitly so the window is deterministic against a
// single instant — the scheduler and chat-router cap checks both pin a `now`
// at the start of their critical section, and tests pin it to a fixed Date.
//
// One round-trip: all four COALESCE(SUM(...)) sit in a single SELECT, scanned
// via the idx_task_usage_created_at index. Returns zeroed totals when the
// window contains no rows so callers can render without null-checks.
//
// SQLite stores task_usage.created_at via CURRENT_TIMESTAMP, which produces
// "YYYY-MM-DD HH:MM:SS". JS Date.toISOString() produces "YYYY-MM-DDTHH:..Z".
// Lexicographic comparison would mis-order the two formats, so the bound
// passes through SQLite's datetime() to coerce the cutoff into the same
// canonical form as the stored values.
export async function getWeeklyTokens(
  db: Knex,
  now: Date
): Promise<WeeklyTokens> {
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  const rows = await db<TaskUsage>("task_usage")
    .whereRaw("created_at >= datetime(?)", [cutoff.toISOString()])
    .select(
      db.raw("COALESCE(SUM(input_tokens), 0) as input"),
      db.raw("COALESCE(SUM(output_tokens), 0) as output"),
      db.raw(
        "COALESCE(SUM(cache_creation_input_tokens), 0) as cache_creation"
      ),
      db.raw("COALESCE(SUM(cache_read_input_tokens), 0) as cache_read")
    );
  const r = rows[0] as Record<string, string | number> | undefined;
  const input = Number(r?.input ?? 0);
  const output = Number(r?.output ?? 0);
  const cache_creation = Number(r?.cache_creation ?? 0);
  const cache_read = Number(r?.cache_read ?? 0);
  return {
    input,
    output,
    cache_creation,
    cache_read,
    total: input + output + cache_creation + cache_read,
  };
}
