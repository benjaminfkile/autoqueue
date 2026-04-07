import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getActiveRepos } from "../db/repos";
import { getIssuesByRepoId, upsertIssue, deleteIssue } from "../db/issues";
import { getOpenIssues } from "./github";

export async function syncIssues(db: Knex, secrets: IAppSecrets): Promise<void> {
  const repos = await getActiveRepos(db);

  for (const repo of repos) {
    const ghIssues = await getOpenIssues(secrets.GH_PAT, repo.owner, repo.repo_name);
    const dbIssues = await getIssuesByRepoId(db, repo.id);

    const maxQueuePosition = dbIssues.reduce(
      (max, i) => (i.queue_position > max ? i.queue_position : max),
      0
    );
    let nextPosition = maxQueuePosition + 1;

    let upserted = 0;

    for (const ghIssue of ghIssues) {
      const labels = (
        ghIssue.labels as Array<string | { name?: string | null }>
      ).map((l) => (typeof l === "string" ? l : (l.name ?? "")));

      const is_container = labels.some((l) => l.toLowerCase() === "container");
      const is_manual = labels.some((l) => l.toLowerCase() === "manual");

      const body = ghIssue.body ?? "";
      const parentMatch =
        body.match(/Part of #(\d+)/) ??
        body.match(/Parent:\s*#(\d+)/) ??
        body.match(/https?:\/\/[^\s]*\/issues\/(\d+)/);
      const parent_issue_number = parentMatch ? parseInt(parentMatch[1], 10) : null;

      const existing = dbIssues.find((i) => i.issue_number === ghIssue.number);
      const queue_position = existing ? existing.queue_position : nextPosition++;

      await upsertIssue(db, {
        repo_id: repo.id,
        issue_number: ghIssue.number,
        parent_issue_number,
        queue_position,
        is_manual,
        is_container,
      });

      upserted++;
    }

    const openNumbers = new Set(ghIssues.map((i) => i.number));
    const toDelete = dbIssues.filter(
      (i) => !openNumbers.has(i.issue_number) && i.status !== "active"
    );

    for (const issue of toDelete) {
      await deleteIssue(db, issue.id);
    }

    console.log(
      `[issueSync] ${repo.owner}/${repo.repo_name}: ${upserted} upserted, ${toDelete.length} removed`
    );
  }
}
