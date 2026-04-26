import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("task_usage", (table) => {
    table.increments("id").primary();
    table
      .integer("task_id")
      .notNullable()
      .references("id")
      .inTable("tasks")
      .onDelete("CASCADE");
    table
      .integer("repo_id")
      .notNullable()
      .references("id")
      .inTable("repos")
      .onDelete("CASCADE");
    table.integer("input_tokens").notNullable().defaultTo(0);
    table.integer("output_tokens").notNullable().defaultTo(0);
    table.integer("cache_creation_input_tokens").notNullable().defaultTo(0);
    table.integer("cache_read_input_tokens").notNullable().defaultTo(0);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["task_id"], "idx_task_usage_task_id");
    table.index(["repo_id"], "idx_task_usage_repo_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("task_usage");
}
