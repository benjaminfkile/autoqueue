import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getActiveRepos } from "../db/repos";
import { getIssuesByRepoId, upsertIssue, deleteIssue } from "../db/issues";
import { getOpenIssues, getSubIssueNumbers } from "./github";

export async function syncIssues(db: Knex, secrets: IAppSecrets): Promise<void> {
  const repos = await getActiveRepos(db);

  for (const repo of repos) {
    const ghIssues = await getOpenIssues(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name);
    const dbIssues = await getIssuesByRepoId(db, repo.id);

    // Build a map of child issue_number -> parent issue_number using the GitHub sub-issues API
    const parentMap = new Map<number, number>();
    const containerIssues = ghIssues.filter((i) => {
      const labels = (i.labels as Array<string | { name?: string | null }>).map((l) =>
        typeof l === "string" ? l : (l.name ?? "")
      );
      return labels.some((l) => l.toLowerCase() === "container");
    });
    for (const container of containerIssues) {
      const children = await getSubIssueNumbers(
        secrets.GITHUB_TOKEN!,
        repo.owner,
        repo.repo_name,
        container.number
      );
      for (const childNum of children) {
        parentMap.set(childNum, container.number);
      }
    }

    let nextPosition = 1;
    let upserted = 0;

    const sortedIssues = [...ghIssues].sort((a, b) => a.number - b.number);

    for (const ghIssue of sortedIssues) {
      const labels = (
        ghIssue.labels as Array<string | { name?: string | null }>
      ).map((l) => (typeof l === "string" ? l : (l.name ?? "")));

      const is_container = labels.some((l) => l.toLowerCase() === "container");
      const is_manual = labels.some((l) => l.toLowerCase() === "manual");
      const parent_issue_number = parentMap.get(ghIssue.number) ?? null;

      const queue_position = nextPosition++;

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
    // Only remove pending issues that were closed/deleted on GitHub.
    // Keep done/failed records so history is preserved for the console app.
    const toDelete = dbIssues.filter(
      (i) => !openNumbers.has(i.issue_number) && i.status === "pending"
    );

    for (const issue of toDelete) {
      await deleteIssue(db, issue.id);
    }

    console.log(
      `[issueSync] ${repo.owner}/${repo.repo_name}: ${upserted} upserted, ${toDelete.length} removed`
    );
  }
}
