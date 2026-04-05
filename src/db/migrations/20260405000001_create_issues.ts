import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
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
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["repo_id", "issue_number"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("issues");
}
