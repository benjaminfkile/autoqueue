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
  return db<Issue>("issues as i")
    .where("i.repo_id", repoId)
    .where("i.status", "pending")
    .where(function () {
      this.whereNull("i.parent_issue_number").orWhereExists(
        db<Issue>("issues as parent")
          .select(db.raw("1"))
          .where("parent.repo_id", repoId)
          .whereRaw("parent.issue_number = i.parent_issue_number")
          .where("parent.status", "done")
      );
    })
    .orderBy("i.queue_position", "asc")
    .first();
}

export async function upsertIssue(
  db: Knex,
  data: {
    repo_id: number;
    issue_number: number;
    parent_issue_number?: number | null;
    queue_position: number;
    is_manual?: boolean;
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

export async function deleteIssue(db: Knex, id: number): Promise<void> {
  await db<Issue>("issues").where({ id }).delete();
}
