import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tasks", (table) => {
    table.increments("id").primary();
    table
      .integer("repo_id")
      .notNullable()
      .references("id")
      .inTable("repos")
      .onDelete("CASCADE");
    table
      .integer("parent_id")
      .nullable()
      .references("id")
      .inTable("tasks")
      .onDelete("CASCADE");
    table.string("title").notNullable();
    table.text("description").notNullable().defaultTo("");
    table.integer("order_position").notNullable().defaultTo(0);
    table.string("status").notNullable().defaultTo("pending");
    table.integer("retry_count").notNullable().defaultTo(0);
    table.string("pr_url").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["repo_id", "status"], "idx_tasks_repo_id_status");
    table.index(["parent_id"], "idx_tasks_parent_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tasks");
}
