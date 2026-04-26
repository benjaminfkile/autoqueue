import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("task_templates", (table) => {
    table.increments("id").primary();
    table.string("name").notNullable();
    table.text("description").notNullable().defaultTo("");
    table.text("tree").notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["name"], "idx_task_templates_name");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("task_templates");
}
