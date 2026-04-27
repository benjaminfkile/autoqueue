import { Knex } from "knex";

// Single-row settings table for app-wide defaults that need a typed schema
// (unlike the loose key/value app_settings table). The id is pinned to 1 via
// a CHECK so callers can always SELECT/UPDATE WHERE id=1 without worrying
// about which row "wins". Phase 11 introduces default_model; future typed
// app-wide defaults belong here too.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("settings", (table) => {
    table.integer("id").primary();
    table.text("default_model").notNullable().defaultTo("claude-sonnet-4-6");
    table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    "CREATE TRIGGER settings_singleton_insert BEFORE INSERT ON settings " +
      "WHEN NEW.id <> 1 BEGIN SELECT RAISE(ABORT, 'settings is a single-row table; id must be 1'); END"
  );

  await knex("settings").insert({ id: 1, default_model: "claude-sonnet-4-6" });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw("DROP TRIGGER IF EXISTS settings_singleton_insert");
  await knex.schema.dropTableIfExists("settings");
}
