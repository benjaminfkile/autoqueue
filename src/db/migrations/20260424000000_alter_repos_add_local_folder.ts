import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.boolean("is_local_folder").notNullable().defaultTo(false);
    table.text("local_path").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("is_local_folder");
    table.dropColumn("local_path");
  });
}
