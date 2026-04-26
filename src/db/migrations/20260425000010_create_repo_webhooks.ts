import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("repo_webhooks", (table) => {
    table.increments("id").primary();
    table
      .integer("repo_id")
      .notNullable()
      .references("id")
      .inTable("repos")
      .onDelete("CASCADE");
    table.text("url").notNullable();
    table.text("events").notNullable();
    table.boolean("active").notNullable().defaultTo(true);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["repo_id"], "idx_repo_webhooks_repo_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("repo_webhooks");
}
