// Per-repo dashboard aggregation used by GET /api/repos to drive the
// activity-heat cue and the "most-worked" sort. Exercised against a real
// in-memory SQLite because the query mixes GROUP BY, MAX, SUM CASE, and a
// join across task_events → tasks — mocking the knex chain would test the
// mock, not the SQL.

import knex, { Knex } from "knex";
import { getRepoTaskStatsMap } from "../src/db/tasks";

let db: Knex;

beforeAll(async () => {
  db = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });

  // Minimal schema — the aggregation only needs tasks(repo_id, status,
  // created_at) and task_events(task_id, ts). No FKs required since the
  // aggregation is join-only and expects the caller to have kept referential
  // integrity via the real migration.
  await db.schema.createTable("tasks", (table) => {
    table.increments("id").primary();
    table.integer("repo_id").notNullable();
    table.integer("parent_id").nullable();
    table.text("status").notNullable().defaultTo("pending");
    table.text("created_at").notNullable();
  });
  await db.schema.createTable("task_events", (table) => {
    table.increments("id").primary();
    table.integer("task_id").notNullable();
    table.text("ts").notNullable();
    table.text("event").notNullable();
    table.text("data").nullable();
  });
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db("task_events").delete();
  await db("tasks").delete();
});

describe("getRepoTaskStatsMap", () => {
  it("returns an empty map when no repos have tasks", async () => {
    const stats = await getRepoTaskStatsMap(db);
    expect(stats.size).toBe(0);
  });

  it("counts totals and done tasks per repo, keyed by repo_id", async () => {
    await db("tasks").insert([
      { repo_id: 1, status: "done", created_at: "2026-08-01T00:00:00Z" },
      { repo_id: 1, status: "done", created_at: "2026-08-02T00:00:00Z" },
      { repo_id: 1, status: "pending", created_at: "2026-08-03T00:00:00Z" },
      { repo_id: 2, status: "failed", created_at: "2026-08-04T00:00:00Z" },
    ]);
    const stats = await getRepoTaskStatsMap(db);
    expect(stats.get(1)?.task_total).toBe(3);
    expect(stats.get(1)?.task_done).toBe(2);
    expect(stats.get(2)?.task_total).toBe(1);
    expect(stats.get(2)?.task_done).toBe(0);
  });

  it("picks the max task.created_at as last_activity_at when no events exist", async () => {
    await db("tasks").insert([
      { repo_id: 7, status: "done", created_at: "2026-06-01T00:00:00Z" },
      { repo_id: 7, status: "pending", created_at: "2026-08-10T12:34:56Z" },
    ]);
    const stats = await getRepoTaskStatsMap(db);
    // ISO 8601 normalisation — the aggregation runs through toIso so callers
    // don't have to care whether the driver returned a Date or a string.
    expect(stats.get(7)?.last_activity_at).toBe("2026-08-10T12:34:56.000Z");
  });

  it("prefers a later task_events.ts over the newest task.created_at (activity beats creation)", async () => {
    await db("tasks").insert([
      {
        id: 100,
        repo_id: 9,
        status: "done",
        created_at: "2026-06-01T00:00:00Z",
      },
    ]);
    await db("task_events").insert([
      {
        task_id: 100,
        ts: "2026-08-11T10:00:00Z",
        event: "status_changed",
        data: null,
      },
    ]);
    const stats = await getRepoTaskStatsMap(db);
    expect(stats.get(9)?.last_activity_at).toBe("2026-08-11T10:00:00.000Z");
  });

  it("keeps task.created_at when it is newer than the latest event", async () => {
    await db("tasks").insert([
      {
        id: 200,
        repo_id: 11,
        status: "pending",
        created_at: "2026-08-11T09:00:00Z",
      },
    ]);
    await db("task_events").insert([
      {
        task_id: 200,
        ts: "2026-08-01T00:00:00Z",
        event: "created",
        data: null,
      },
    ]);
    const stats = await getRepoTaskStatsMap(db);
    expect(stats.get(11)?.last_activity_at).toBe("2026-08-11T09:00:00.000Z");
  });

  it("attributes event timestamps to the tasks' repo, not the event row directly", async () => {
    await db("tasks").insert([
      {
        id: 300,
        repo_id: 42,
        status: "done",
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);
    await db("task_events").insert([
      {
        task_id: 300,
        ts: "2026-08-12T00:00:00Z",
        event: "note",
        data: null,
      },
    ]);
    const stats = await getRepoTaskStatsMap(db);
    // repo 42 (the tasks' owner) should get the event's timestamp; no other
    // repo should be affected.
    expect(stats.get(42)?.last_activity_at).toBe("2026-08-12T00:00:00.000Z");
    expect(stats.get(300)).toBeUndefined();
  });
});
