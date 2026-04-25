import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("task_events", (table) => {
    table.increments("id").primary();
    table
      .integer("task_id")
      .notNullable()
      .references("id")
      .inTable("tasks")
      .onDelete("CASCADE");
    table.timestamp("ts", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text("event").notNullable();
    table.jsonb("data").nullable();

    table.index(["task_id", "ts"], "idx_task_events_task_id_ts");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("task_events");
}
