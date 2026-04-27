import { Knex } from "knex";

// Phase 12: weekly token-cap aggregation reads task_usage rows by created_at,
// not by task_id or repo_id. Without an index on created_at, the scheduler's
// cap check would scan the full table on every claim. Adding the index keeps
// the SUM() bounded to the trailing 7-day slice.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("task_usage", (table) => {
    table.index(["created_at"], "idx_task_usage_created_at");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("task_usage", (table) => {
    table.dropIndex(["created_at"], "idx_task_usage_created_at");
  });
}
