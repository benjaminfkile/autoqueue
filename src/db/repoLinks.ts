import { Knex } from "knex";
import { RepoLink, RepoLinkPermission } from "../interfaces";

// The unique expression index on the table is (MIN(a,b), MAX(a,b)), so we
// canonicalize the pair to (min,max) on insert. Without this, callers could
// observe two distinct rows for the same logical link until a duplicate-insert
// from the symmetric side triggered the unique-index conflict.
function normalizePair(a: number, b: number): { repo_a_id: number; repo_b_id: number } {
  return {
    repo_a_id: Math.min(a, b),
    repo_b_id: Math.max(a, b),
  };
}

export async function listLinksForRepo(
  db: Knex,
  repoId: number
): Promise<RepoLink[]> {
  return db<RepoLink>("repo_links")
    .where({ repo_a_id: repoId })
    .orWhere({ repo_b_id: repoId })
    .orderBy("id", "asc");
}

export async function createLink(
  db: Knex,
  a: number,
  b: number,
  role?: string | null,
  permission?: RepoLinkPermission
): Promise<RepoLink> {
  const pair = normalizePair(a, b);
  const [row] = await db<RepoLink>("repo_links")
    .insert({
      ...pair,
      role: role ?? null,
      permission: permission ?? "read",
    })
    .returning("*");
  return row;
}

export async function updateLinkPermission(
  db: Knex,
  id: number,
  permission: RepoLinkPermission
): Promise<RepoLink> {
  const [row] = await db<RepoLink>("repo_links")
    .where({ id })
    .update({ permission })
    .returning("*");
  return row;
}

export async function deleteLink(db: Knex, id: number): Promise<number> {
  return db<RepoLink>("repo_links").where({ id }).delete();
}
