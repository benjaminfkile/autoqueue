import { Knex } from "knex";

// Phase 11: per-task Claude model override. NULL means "inherit from the
// resolved default". Resolution rule (see resolveTaskModel in db/tasks.ts):
//   1. task.model           — explicit per-task override, if set
//   2. nearest ancestor's model — walk parent_id chain; first non-null wins
//   3. settings.default_model  — single-row app default
// Storing the column nullable (rather than copying the resolved model down at
// create time) keeps the inheritance live: changing an ancestor's model
// re-routes all descendants without a backfill, and clearing a task's model
// returns it to the inherited value.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.text("model").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.dropColumn("model");
  });
}
