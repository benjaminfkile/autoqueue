import { Knex } from "knex";
import { Issue } from "../interfaces";

export async function getIssuesByRepoId(
  db: Knex,
  repoId: number
): Promise<Issue[]> {
  return db<Issue>("issues").where({ repo_id: repoId });
}

export async function getIssueByNumber(
  db: Knex,
  repoId: number,
  issueNumber: number
): Promise<Issue | undefined> {
  return db<Issue>("issues")
    .where({ repo_id: repoId, issue_number: issueNumber })
    .first();
}

export async function getNextPendingIssue(
  db: Knex,
  repoId: number
): Promise<Issue | undefined> {
  // Raw SQL ensures the correlated subquery resolves correctly in PostgreSQL.
  const result = await db.raw<{ rows: Issue[] }>(
    `SELECT i.* FROM issues i
     WHERE i.repo_id = ?
       AND i.status = 'pending'
       AND (
         i.parent_issue_number IS NULL
         OR EXISTS (
           SELECT 1 FROM issues parent
           WHERE parent.repo_id = ?
             AND parent.issue_number = i.parent_issue_number
             AND parent.status = 'done'
         )
       )
     ORDER BY i.queue_position ASC
     LIMIT 1`,
    [repoId, repoId]
  );
  return result.rows[0];
}

export async function upsertIssue(
  db: Knex,
  data: {
    repo_id: number;
    issue_number: number;
    parent_issue_number?: number | null;
    queue_position: number;
    is_manual?: boolean;
    is_container?: boolean;
  }
): Promise<Issue> {
  const [issue] = await db<Issue>("issues")
    .insert(data)
    .onConflict(["repo_id", "issue_number"])
    .merge()
    .returning("*");
  return issue;
}

export async function updateIssueStatus(
  db: Knex,
  id: number,
  status: "pending" | "active" | "done"
): Promise<Issue> {
  const [issue] = await db<Issue>("issues")
    .where({ id })
    .update({ status })
    .returning("*");
  return issue;
}

export async function updateIssue(
  db: Knex,
  id: number,
  data: Partial<Issue>
): Promise<Issue> {
  const [issue] = await db<Issue>("issues")
    .where({ id })
    .update(data)
    .returning("*");
  return issue;
}

export async function getActiveIssue(
  db: Knex,
  repoId: number
): Promise<Issue | undefined> {
  return db<Issue>("issues")
    .where({ repo_id: repoId, status: "active" })
    .orderBy("id", "asc")
    .first();
}

export async function deleteIssue(db: Knex, id: number): Promise<void> {
  await db<Issue>("issues").where({ id }).delete();
}
