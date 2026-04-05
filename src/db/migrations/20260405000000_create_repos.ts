import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("repos", (table) => {
    table.increments("id").primary();
    table.string("owner").notNullable();
    table.string("repo_name").notNullable();
    table.boolean("active").notNullable().defaultTo(true);
    table.integer("webhook_id").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["owner", "repo_name"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("repos");
}
