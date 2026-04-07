import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("webhook_id");
    table.string("base_branch").notNullable().defaultTo("main");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("base_branch");
    table.integer("webhook_id").nullable();
  });
}
