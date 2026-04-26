import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.text("worker_id").nullable();
    table.timestamp("leased_until").nullable();
    table.index(["status", "leased_until"], "idx_tasks_status_leased_until");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.dropIndex(["status", "leased_until"], "idx_tasks_status_leased_until");
    table.dropColumn("worker_id");
    table.dropColumn("leased_until");
  });
}
