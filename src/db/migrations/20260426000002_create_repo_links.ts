import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("repo_links", (table) => {
    table.increments("id").primary();
    table
      .integer("repo_a_id")
      .notNullable()
      .references("id")
      .inTable("repos")
      .onDelete("CASCADE");
    table
      .integer("repo_b_id")
      .notNullable()
      .references("id")
      .inTable("repos")
      .onDelete("CASCADE");
    table.text("role").nullable();
    table
      .text("permission")
      .notNullable()
      .defaultTo("read")
      .checkIn(["read", "write"]);
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());

    table.index(["repo_a_id"], "idx_repo_links_repo_a_id");
    table.index(["repo_b_id"], "idx_repo_links_repo_b_id");
  });

  // Symmetric uniqueness: a link between repos X and Y is the same as Y and X,
  // regardless of which id was inserted as repo_a_id. SQLite's two-arg scalar
  // MIN/MAX are deterministic, so we can canonicalize the pair inside an
  // expression index and let SQLite enforce uniqueness on (smaller, larger).
  await knex.schema.raw(
    "CREATE UNIQUE INDEX idx_repo_links_pair ON repo_links (MIN(repo_a_id, repo_b_id), MAX(repo_a_id, repo_b_id))"
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("repo_links");
}
