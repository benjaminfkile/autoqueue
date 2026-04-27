import knex, { Knex } from "knex";
import path from "path";
import {
  getDailyTokens,
  getWeeklyTokens,
} from "../src/db/usageAggregations";

// ---------------------------------------------------------------------------
// Pure-mock unit tests — verify the call shape without a real DB. The
// boundary tests further down exercise the actual SQL against SQLite.
// ---------------------------------------------------------------------------
function createMockKnex() {
  const chain: Record<string, jest.Mock> = {};
  const methods = ["whereRaw", "andWhere", "select"];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnThis();
  }
  const k = jest.fn().mockReturnValue(chain) as unknown as jest.Mock & {
    raw: jest.Mock;
  };
  k.raw = jest.fn((sql: string) => sql);
  return { knex: k, chain };
}

describe("getWeeklyTokens — call shape", () => {
  it("queries task_usage and bounds the window at exactly now - 7d via SQLite datetime() so format normalization is consistent across stored CURRENT_TIMESTAMP and bound ISO strings", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([
      {
        input: "0",
        output: "0",
        cache_creation: "0",
        cache_read: "0",
      },
    ]);

    const now = new Date("2026-04-26T12:00:00.000Z");
    await getWeeklyTokens(knex as any, now);

    expect(knex).toHaveBeenCalledWith("task_usage");
    expect(chain.whereRaw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = chain.whereRaw.mock.calls[0];
    expect(sql).toBe("created_at >= datetime(?)");
    // Cutoff is exactly 7 days before `now` — pinning this protects against
    // off-by-one rollover bugs (a stray hour would silently leak rows in or
    // out of the window).
    expect(bindings).toEqual(["2026-04-19T12:00:00.000Z"]);
  });

  it("issues a single SELECT with all four COALESCE(SUM(...)) columns so the cap check is one round-trip even on the hot path", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([
      {
        input: "0",
        output: "0",
        cache_creation: "0",
        cache_read: "0",
      },
    ]);

    await getWeeklyTokens(knex as any, new Date("2026-04-26T00:00:00.000Z"));

    expect(chain.select).toHaveBeenCalledTimes(1);
    const args = chain.select.mock.calls[0] as string[];
    expect(args).toHaveLength(4);
    expect(args[0]).toContain("SUM(input_tokens)");
    expect(args[0]).toContain("as input");
    expect(args[1]).toContain("SUM(output_tokens)");
    expect(args[1]).toContain("as output");
    expect(args[2]).toContain("SUM(cache_creation_input_tokens)");
    expect(args[2]).toContain("as cache_creation");
    expect(args[3]).toContain("SUM(cache_read_input_tokens)");
    expect(args[3]).toContain("as cache_read");
    // COALESCE wraps every SUM so an empty window collapses to 0 instead of
    // NULL — callers can render without null-checks.
    for (const a of args) expect(a).toContain("COALESCE");
  });

  it("returns each token category and a precomputed total so callers comparing against settings.weekly_token_cap don't have to reduce the breakdown themselves", async () => {
    const { knex, chain } = createMockKnex();
    // SQLite returns SUM as either number or string (BIGINT widening). Mix
    // both shapes here to verify the helper coerces consistently.
    chain.select.mockResolvedValueOnce([
      {
        input: "100",
        output: 200,
        cache_creation: "50",
        cache_read: 1000,
      },
    ]);

    const result = await getWeeklyTokens(
      knex as any,
      new Date("2026-04-26T00:00:00.000Z")
    );

    expect(result).toEqual({
      input: 100,
      output: 200,
      cache_creation: 50,
      cache_read: 1000,
      total: 1350,
    });
  });

  it("returns zeroed totals when the result set is empty (no rows from the aggregate query)", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([]);

    const result = await getWeeklyTokens(
      knex as any,
      new Date("2026-04-26T00:00:00.000Z")
    );

    expect(result).toEqual({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });
  });

  it("returns zeroed totals when COALESCE collapsed every SUM to 0 (window had no matching rows)", async () => {
    const { knex, chain } = createMockKnex();
    chain.select.mockResolvedValueOnce([
      {
        input: "0",
        output: "0",
        cache_creation: "0",
        cache_read: "0",
      },
    ]);

    const result = await getWeeklyTokens(
      knex as any,
      new Date("2026-04-26T00:00:00.000Z")
    );

    expect(result).toEqual({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests against real SQLite — verify that the cutoff/window
// semantics actually behave as advertised. Pure-mock tests above pin the
// call shape; these pin the SQL behavior (rollover, empty window).
//
// We build a fresh in-memory database, replay the create_task_usage
// schema, then drive getWeeklyTokens against rows we insert by hand. All
// rows use SQLite's CURRENT_TIMESTAMP form ("YYYY-MM-DD HH:MM:SS") because
// that's what defaultTo(knex.fn.now()) produces in production — the helper
// passes the cutoff through datetime() to coerce the bound parameter into
// the same canonical form so lexicographic comparison stays correct.
// ---------------------------------------------------------------------------
describe("getWeeklyTokens — boundary conditions against real SQLite", () => {
  let db: Knex;

  beforeAll(async () => {
    db = knex({
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });
    // Minimal schema — enough to exercise getWeeklyTokens. We don't need the
    // FK targets (tasks, repos) since the in-memory db has no constraints
    // attached to those columns here; created_at is the only column that
    // affects the helper.
    await db.schema.createTable("task_usage", (table) => {
      table.increments("id").primary();
      table.integer("task_id").notNullable();
      table.integer("repo_id").notNullable();
      table.integer("input_tokens").notNullable().defaultTo(0);
      table.integer("output_tokens").notNullable().defaultTo(0);
      table
        .integer("cache_creation_input_tokens")
        .notNullable()
        .defaultTo(0);
      table
        .integer("cache_read_input_tokens")
        .notNullable()
        .defaultTo(0);
      table.text("created_at").notNullable();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db("task_usage").delete();
  });

  // Helper: insert a usage row with an explicit created_at. We always pass
  // the timestamp in SQLite's "YYYY-MM-DD HH:MM:SS" form because that's the
  // format CURRENT_TIMESTAMP (and therefore defaultTo(knex.fn.now())) writes
  // in production; the helper relies on stored values being in this canonical
  // form so the bound cutoff (passed through datetime()) compares
  // lexicographically against them.
  async function insertUsage(opts: {
    created_at: string;
    input?: number;
    output?: number;
    cache_creation?: number;
    cache_read?: number;
  }) {
    await db("task_usage").insert({
      task_id: 1,
      repo_id: 1,
      input_tokens: opts.input ?? 0,
      output_tokens: opts.output ?? 0,
      cache_creation_input_tokens: opts.cache_creation ?? 0,
      cache_read_input_tokens: opts.cache_read ?? 0,
      created_at: opts.created_at,
    });
  }

  it("returns zeroed totals on an empty window (no rows in task_usage at all)", async () => {
    const result = await getWeeklyTokens(
      db,
      new Date("2026-04-26T12:00:00.000Z")
    );
    expect(result).toEqual({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });
  });

  it("returns zeroed totals when every row predates the 7-day window", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    // Both rows are older than 7 days → both excluded.
    await insertUsage({
      created_at: "2026-04-10 00:00:00",
      input: 999,
    });
    await insertUsage({
      created_at: "2026-04-19 11:59:59",
      input: 500,
    });

    const result = await getWeeklyTokens(db, now);
    expect(result.total).toBe(0);
    expect(result.input).toBe(0);
  });

  it("rollover boundary: a row exactly at now - 7d is INCLUDED (>= cutoff is inclusive)", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    // Cutoff (after datetime() coercion) is "2026-04-19 12:00:00". A row at
    // the same instant is included because the comparison is `>=`.
    await insertUsage({
      created_at: "2026-04-19 12:00:00",
      input: 100,
    });

    const result = await getWeeklyTokens(db, now);
    expect(result.input).toBe(100);
    expect(result.total).toBe(100);
  });

  it("rollover boundary: a row one second before now - 7d is EXCLUDED", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    await insertUsage({
      created_at: "2026-04-19 11:59:59",
      input: 100,
    });

    const result = await getWeeklyTokens(db, now);
    expect(result.total).toBe(0);
  });

  it("rollover boundary: rows fall out of the window as `now` advances (the same row is in for one window and out for the next)", async () => {
    // A row at 2026-04-19 13:00:00 is inside a window ending 2026-04-26 12:00
    // (cutoff = 2026-04-19 12:00) but outside one ending 2026-04-26 14:00
    // (cutoff = 2026-04-19 14:00) — verifying the trailing-edge sweep.
    await insertUsage({
      created_at: "2026-04-19 13:00:00",
      input: 42,
    });

    const earlier = await getWeeklyTokens(
      db,
      new Date("2026-04-26T12:00:00.000Z")
    );
    expect(earlier.input).toBe(42);

    const later = await getWeeklyTokens(
      db,
      new Date("2026-04-26T14:00:00.000Z")
    );
    expect(later.input).toBe(0);
  });

  it("sums all four token categories across multiple rows in the window and computes the total", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    await insertUsage({
      created_at: "2026-04-20 00:00:00",
      input: 100,
      output: 200,
      cache_creation: 10,
      cache_read: 1000,
    });
    await insertUsage({
      created_at: "2026-04-25 00:00:00",
      input: 50,
      output: 75,
      cache_creation: 5,
      cache_read: 500,
    });
    // Outside the window — must not affect the totals.
    await insertUsage({
      created_at: "2026-04-01 00:00:00",
      input: 9999,
      output: 9999,
      cache_creation: 9999,
      cache_read: 9999,
    });

    const result = await getWeeklyTokens(db, now);
    expect(result).toEqual({
      input: 150,
      output: 275,
      cache_creation: 15,
      cache_read: 1500,
      total: 150 + 275 + 15 + 1500,
    });
  });

  it("treats sub-second cutoff precision correctly — datetime() truncates to seconds, so a row written 'before' the cutoff in ms terms but 'at' the cutoff in second terms is included (matches CURRENT_TIMESTAMP precision)", async () => {
    // CURRENT_TIMESTAMP only has second precision, so the helper's window is
    // effectively second-aligned. A `now` of 12:00:00.500 still produces a
    // cutoff of 12:00:00 after datetime() coercion — a row at 12:00:00 of the
    // cutoff date is therefore included.
    const now = new Date("2026-04-26T12:00:00.500Z");
    await insertUsage({
      created_at: "2026-04-19 12:00:00",
      input: 7,
    });
    const result = await getWeeklyTokens(db, now);
    expect(result.input).toBe(7);
  });

  // Defensive sanity check: the migration that added the created_at index
  // exists and is loadable. The helper depends on that index for "runs
  // efficiently against task_usage" on the scheduler hot path; if a future
  // refactor deletes the migration we want to fail loudly here.
  it("the idx_task_usage_created_at migration is shipped (scheduler hot-path index)", () => {
    const migration = require(path.join(
      "..",
      "src",
      "db",
      "migrations",
      "20260426000006_alter_task_usage_add_created_at_index"
    ));
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Daily-bucket aggregation — drives the /api/usage/weekly chart. The SPA
// expects a contiguous trailing-N-day timeline with zero-fill, so a chart can
// render bars by index without re-deriving the date axis.
// ---------------------------------------------------------------------------
describe("getDailyTokens — boundary conditions against real SQLite", () => {
  let db: Knex;

  beforeAll(async () => {
    db = knex({
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });
    await db.schema.createTable("task_usage", (table) => {
      table.increments("id").primary();
      table.integer("task_id").notNullable();
      table.integer("repo_id").notNullable();
      table.integer("input_tokens").notNullable().defaultTo(0);
      table.integer("output_tokens").notNullable().defaultTo(0);
      table
        .integer("cache_creation_input_tokens")
        .notNullable()
        .defaultTo(0);
      table
        .integer("cache_read_input_tokens")
        .notNullable()
        .defaultTo(0);
      table.text("created_at").notNullable();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db("task_usage").delete();
  });

  async function insertUsage(opts: {
    created_at: string;
    input?: number;
    output?: number;
    cache_creation?: number;
    cache_read?: number;
  }) {
    await db("task_usage").insert({
      task_id: 1,
      repo_id: 1,
      input_tokens: opts.input ?? 0,
      output_tokens: opts.output ?? 0,
      cache_creation_input_tokens: opts.cache_creation ?? 0,
      cache_read_input_tokens: opts.cache_read ?? 0,
      created_at: opts.created_at,
    });
  }

  it("returns exactly `days` zero-filled buckets when the window has no rows so the SPA chart always has a contiguous timeline", async () => {
    const result = await getDailyTokens(
      db,
      new Date("2026-04-26T12:00:00.000Z"),
      30
    );
    expect(result).toHaveLength(30);
    expect(result.every((b) => b.total === 0)).toBe(true);
    // First and last bucket bracket the expected window: 30-day trailing
    // ending today inclusive → start = today - 29 days.
    expect(result[0].date).toBe("2026-03-28");
    expect(result[result.length - 1].date).toBe("2026-04-26");
  });

  it("aggregates rows into UTC date buckets and zero-fills empty days between them", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    await insertUsage({
      created_at: "2026-04-25 10:00:00",
      input: 100,
      output: 50,
    });
    await insertUsage({
      created_at: "2026-04-25 12:00:00",
      input: 25,
    });
    await insertUsage({
      created_at: "2026-04-26 00:30:00",
      input: 7,
    });

    const result = await getDailyTokens(db, now, 5);

    expect(result).toHaveLength(5);
    // Days inside the window with no usage stay zero — the SPA relies on this
    // for evenly spaced bars.
    const byDate = Object.fromEntries(result.map((b) => [b.date, b.total]));
    expect(byDate["2026-04-22"]).toBe(0);
    expect(byDate["2026-04-23"]).toBe(0);
    expect(byDate["2026-04-24"]).toBe(0);
    expect(byDate["2026-04-25"]).toBe(100 + 50 + 25);
    expect(byDate["2026-04-26"]).toBe(7);
  });

  it("excludes rows outside the trailing window — a row from before the start day must not bleed into the first bucket", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    // 5-day window → start = 2026-04-22. This row is on 2026-04-21 → out.
    await insertUsage({
      created_at: "2026-04-21 23:59:59",
      input: 9999,
    });
    await insertUsage({
      created_at: "2026-04-22 00:00:00",
      input: 42,
    });

    const result = await getDailyTokens(db, now, 5);
    const byDate = Object.fromEntries(result.map((b) => [b.date, b.total]));
    expect(byDate["2026-04-22"]).toBe(42);
    // The chart must not display a value derived from rows outside the
    // window — verify total across all buckets matches only the in-window row.
    const sum = result.reduce((s, b) => s + b.total, 0);
    expect(sum).toBe(42);
  });

  it("sums all four token categories into the daily total so the chart matches the cap-comparison total in getWeeklyTokens", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    await insertUsage({
      created_at: "2026-04-26 09:00:00",
      input: 1,
      output: 2,
      cache_creation: 4,
      cache_read: 8,
    });

    const result = await getDailyTokens(db, now, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: "2026-04-26", total: 1 + 2 + 4 + 8 });
  });

  it("rejects a non-positive days argument so a misuse fails loudly instead of returning an empty array", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    await expect(getDailyTokens(db, now, 0)).rejects.toThrow(
      /positive integer/
    );
    await expect(getDailyTokens(db, now, -1)).rejects.toThrow(
      /positive integer/
    );
    await expect(getDailyTokens(db, now, 1.5)).rejects.toThrow(
      /positive integer/
    );
  });
});
