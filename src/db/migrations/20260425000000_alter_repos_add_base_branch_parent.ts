import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.text("base_branch_parent").nullable().defaultTo("main");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("base_branch_parent");
  });
}
