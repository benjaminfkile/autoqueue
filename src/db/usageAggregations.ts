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

// One bucket of the daily-usage chart. `date` is the UTC day in YYYY-MM-DD form
// so the SPA can render evenly-spaced bars without parsing timestamps. `total`
// sums all four token categories for the day, matching how the weekly cap is
// evaluated, so a daily bar reaching the (cap / 7) line correlates with the
// rate that would consume the cap in a week.
export interface DailyTokenBucket {
  date: string;
  total: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

// Group task_usage rows into daily totals across the trailing `days` window
// (default 30, matching the usage dashboard chart). Days with no recorded
// usage are zero-filled in JS so the SPA can render a contiguous timeline
// without re-deriving the date axis. `date` keys are UTC YYYY-MM-DD.
//
// SQLite stores created_at as text via CURRENT_TIMESTAMP ("YYYY-MM-DD ...").
// `date(created_at)` returns the YYYY-MM-DD portion under SQLite's UTC
// interpretation, which lines up with the JS-side bucket keys we synthesize
// from `now`. The cutoff is bound the same way as getWeeklyTokens — through
// SQLite's datetime() so format normalization stays consistent.
export async function getDailyTokens(
  db: Knex,
  now: Date,
  days: number = 30
): Promise<DailyTokenBucket[]> {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("days must be a positive integer");
  }
  // Window spans the calendar day `days - 1` ago through today, so the chart
  // shows exactly `days` buckets including today. e.g. days=30 with now on
  // 2026-04-26 covers 2026-03-28 .. 2026-04-26 inclusive.
  const today = utcDayKey(now);
  const start = new Date(now.getTime() - (days - 1) * ONE_DAY_MS);
  const startKey = utcDayKey(start);
  const cutoffIso = `${startKey}T00:00:00.000Z`;

  const rows = (await db<TaskUsage>("task_usage")
    .whereRaw("created_at >= datetime(?)", [cutoffIso])
    .select(
      db.raw("date(created_at) as day"),
      db.raw(
        "COALESCE(SUM(input_tokens), 0) + " +
          "COALESCE(SUM(output_tokens), 0) + " +
          "COALESCE(SUM(cache_creation_input_tokens), 0) + " +
          "COALESCE(SUM(cache_read_input_tokens), 0) as total"
      )
    )
    .groupBy("day")) as Array<{ day: string; total: string | number }>;

  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.day, Number(r.total ?? 0));
  }

  const buckets: DailyTokenBucket[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * ONE_DAY_MS);
    const key = utcDayKey(d);
    buckets.push({ date: key, total: totals.get(key) ?? 0 });
  }
  // Sanity: today's bucket should be the last one we synthesized. If the
  // arithmetic above ever drifted (DST in non-UTC envs, leap-second weirdness)
  // we'd want the SPA to still see today's slot — guarantee it explicitly.
  if (buckets[buckets.length - 1]?.date !== today) {
    buckets[buckets.length - 1] = {
      date: today,
      total: totals.get(today) ?? 0,
    };
  }
  return buckets;
}

function utcDayKey(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
