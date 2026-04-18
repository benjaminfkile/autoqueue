import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("issues");

  await knex.schema.createTable("acceptance_criteria", (table) => {
    table.increments("id").primary();
    table
      .integer("task_id")
      .notNullable()
      .references("id")
      .inTable("tasks")
      .onDelete("CASCADE");
    table.text("description").notNullable();
    table.integer("order_position").notNullable().defaultTo(0);
    table.boolean("met").notNullable().defaultTo(false);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["task_id"], "idx_acceptance_criteria_task_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("acceptance_criteria");

  await knex.schema.createTable("issues", (table) => {
    table.increments("id").primary();
    table
      .integer("repo_id")
      .notNullable()
      .references("id")
      .inTable("repos")
      .onDelete("CASCADE");
    table.integer("issue_number").notNullable();
    table.integer("parent_issue_number").nullable();
    table.integer("queue_position").notNullable();
    table.string("status").notNullable().defaultTo("pending");
    table.boolean("is_manual").notNullable().defaultTo(false);
    table.integer("retry_count").notNullable().defaultTo(0);
    table.boolean("is_container").notNullable().defaultTo(false);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["repo_id", "issue_number"]);
  });
}
