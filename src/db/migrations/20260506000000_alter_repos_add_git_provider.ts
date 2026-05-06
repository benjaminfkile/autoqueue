import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.renameColumn("github_token", "git_pat");
  });
  await knex.schema.alterTable("repos", (table) => {
    table.string("git_provider").notNullable().defaultTo("github");
    table.string("ado_project").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("git_provider");
    table.dropColumn("ado_project");
  });
  await knex.schema.alterTable("repos", (table) => {
    table.renameColumn("git_pat", "github_token");
  });
}
