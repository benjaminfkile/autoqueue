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
       AND i.is_manual = false
       AND i.is_container = false
     ORDER BY i.queue_position ASC
     LIMIT 1`,
    [repoId]
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
    .merge(["parent_issue_number", "queue_position", "is_manual", "is_container"])
    .returning("*");
  return issue;
}

export async function updateIssueStatus(
  db: Knex,
  id: number,
  status: "pending" | "active" | "done" | "failed"
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

export async function resetActiveIssues(db: Knex): Promise<number> {
  const rows = await db<Issue>("issues")
    .where({ status: "active" })
    .update({ status: "pending" })
    .returning("id");
  return rows.length;
}

export async function autoCompleteContainers(db: Knex, repoId: number): Promise<number> {
  const result = await db.raw<{ rowCount: number }>(
    `UPDATE issues SET status = 'done'
     WHERE repo_id = ?
       AND is_container = true
       AND status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM issues child
         WHERE child.repo_id = issues.repo_id
           AND child.is_container = false
           AND child.is_manual = false
           AND child.status IN ('pending', 'active')
           AND child.queue_position > issues.queue_position
           AND child.queue_position < COALESCE((
             SELECT MIN(nc.queue_position)
             FROM issues nc
             WHERE nc.repo_id = issues.repo_id
               AND nc.is_container = true
               AND nc.queue_position > issues.queue_position
           ), 2147483647)
       )`,
    [repoId]
  );
  return result.rowCount ?? 0;
}
