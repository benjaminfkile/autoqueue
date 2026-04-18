import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.boolean("require_pr").notNullable().defaultTo(false);
    table.string("github_token").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("require_pr");
    table.dropColumn("github_token");
  });
}
