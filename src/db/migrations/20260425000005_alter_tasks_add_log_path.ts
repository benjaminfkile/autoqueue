import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.text("log_path").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tasks", (table) => {
    table.dropColumn("log_path");
  });
}
