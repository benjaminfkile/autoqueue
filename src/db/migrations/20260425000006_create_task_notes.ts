import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("task_notes", (table) => {
    table.increments("id").primary();
    table
      .integer("task_id")
      .notNullable()
      .references("id")
      .inTable("tasks")
      .onDelete("CASCADE");
    table.text("author").notNullable();
    table.text("visibility").notNullable();
    table.jsonb("tags").notNullable().defaultTo("[]");
    table.text("content").notNullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(
      ["task_id", "created_at"],
      "idx_task_notes_task_id_created_at"
    );
    table.index(["visibility"], "idx_task_notes_visibility");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("task_notes");
}
