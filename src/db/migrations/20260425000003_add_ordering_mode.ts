import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.text("ordering_mode").notNullable().defaultTo("sequential");
  });
  await knex.schema.alterTable("tasks", (table) => {
    table.text("ordering_mode").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.dropColumn("ordering_mode");
  });
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("ordering_mode");
  });
}
