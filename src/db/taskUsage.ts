import { Knex } from "knex";
import { TaskUsage, TokenUsage } from "../interfaces";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  run_count: number;
}

export async function recordTaskUsage(
  db: Knex,
  data: {
    task_id: number;
    repo_id: number;
    usage: TokenUsage;
  }
): Promise<TaskUsage> {
  const [row] = await db<TaskUsage>("task_usage")
    .insert({
      task_id: data.task_id,
      repo_id: data.repo_id,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      cache_creation_input_tokens: data.usage.cache_creation_input_tokens,
      cache_read_input_tokens: data.usage.cache_read_input_tokens,
    })
    .returning("*");
  return row;
}

export async function getUsageRowsForTask(
  db: Knex,
  taskId: number
): Promise<TaskUsage[]> {
  return db<TaskUsage>("task_usage")
    .where({ task_id: taskId })
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");
}

// Sum every column across all rows that match the where clause. Returns zeroed
// totals (and run_count: 0) when no rows match — callers can treat that as
// "this task / repo has no recorded usage yet" without null-checks.
async function sumUsage(
  db: Knex,
  where: Partial<{ task_id: number; repo_id: number }>
): Promise<UsageTotals> {
  const rows = await db<TaskUsage>("task_usage")
    .where(where)
    .select(
      db.raw("COALESCE(SUM(input_tokens), 0)::bigint as input_tokens"),
      db.raw("COALESCE(SUM(output_tokens), 0)::bigint as output_tokens"),
      db.raw(
        "COALESCE(SUM(cache_creation_input_tokens), 0)::bigint as cache_creation_input_tokens"
      ),
      db.raw(
        "COALESCE(SUM(cache_read_input_tokens), 0)::bigint as cache_read_input_tokens"
      ),
      db.raw("COUNT(*)::bigint as run_count")
    );
  const r = rows[0] as Record<string, string | number> | undefined;
  return {
    input_tokens: Number(r?.input_tokens ?? 0),
    output_tokens: Number(r?.output_tokens ?? 0),
    cache_creation_input_tokens: Number(
      r?.cache_creation_input_tokens ?? 0
    ),
    cache_read_input_tokens: Number(r?.cache_read_input_tokens ?? 0),
    run_count: Number(r?.run_count ?? 0),
  };
}

export async function getUsageTotalsForTask(
  db: Knex,
  taskId: number
): Promise<UsageTotals> {
  return sumUsage(db, { task_id: taskId });
}

export async function getUsageTotalsForRepo(
  db: Knex,
  repoId: number
): Promise<UsageTotals> {
  return sumUsage(db, { repo_id: repoId });
}
