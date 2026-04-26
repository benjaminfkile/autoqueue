import { Knex } from "knex";
import * as fs from "fs";
import * as path from "path";

interface RepoRow {
  id: number;
  owner: string | null;
  repo_name: string | null;
  is_local_folder: number | boolean;
  local_path: string | null;
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.text("clone_status").notNullable().defaultTo("pending");
    table.text("clone_error").nullable();
  });

  // Backfill existing rows: 'ready' if the on-disk clone (or local_path) is
  // present, otherwise 'error'. New rows default to 'pending' and will be
  // promoted by the auto-clone flow before insert.
  const reposPath = process.env.REPOS_PATH ?? "";
  const rows = await knex<RepoRow>("repos").select(
    "id",
    "owner",
    "repo_name",
    "is_local_folder",
    "local_path"
  );

  for (const row of rows) {
    const isLocalFolder = !!row.is_local_folder;
    const candidatePath = isLocalFolder
      ? row.local_path
      : reposPath && row.owner && row.repo_name
        ? path.join(reposPath, row.owner, row.repo_name)
        : null;

    const status =
      candidatePath && fs.existsSync(candidatePath) ? "ready" : "error";

    await knex("repos").where({ id: row.id }).update({ clone_status: status });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("repos", (table) => {
    table.dropColumn("clone_status");
    table.dropColumn("clone_error");
  });
}
