import { Knex } from "knex";

// Phase 12: configurable token usage caps. Both columns are nullable bigints
// where NULL means "unlimited" — this lets the helper module distinguish
// "no cap configured" from "cap of zero" (which would block all work) without
// a sentinel value. bigInteger is used because cumulative token counts over a
// week can exceed 32-bit range on heavy use.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("settings", (table) => {
    table.bigInteger("weekly_token_cap").nullable();
    table.bigInteger("session_token_cap").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("settings", (table) => {
    table.dropColumn("weekly_token_cap");
    table.dropColumn("session_token_cap");
  });
}
