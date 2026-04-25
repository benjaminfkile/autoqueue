import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.text("on_failure").notNullable().defaultTo("halt_repo");
    table.integer("max_retries").notNullable().defaultTo(3);
    table.text("on_parent_child_fail").notNullable().defaultTo("mark_partial");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("on_failure");
    table.dropColumn("max_retries");
    table.dropColumn("on_parent_child_fail");
  });
}
