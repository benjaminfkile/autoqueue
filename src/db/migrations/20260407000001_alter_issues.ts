import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("issues", (table) => {
    table.integer("retry_count").notNullable().defaultTo(0);
    table.boolean("is_container").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("issues", (table) => {
    table.dropColumn("retry_count");
    table.dropColumn("is_container");
  });
}
