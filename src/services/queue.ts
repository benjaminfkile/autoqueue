import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getNextPendingIssue, updateIssueStatus } from "../db/issues";
import { getActiveRepos, getRepoById, updateRepo } from "../db/repos";
import {
  assignCopilot,
  assignHuman,
  postIssueComment,
  registerWebhook,
} from "./github";

export async function advanceQueue(
  db: Knex,
  secrets: IAppSecrets,
  repoId: number
): Promise<void> {
  const issue = await getNextPendingIssue(db, repoId);

  if (!issue) {
    console.log(`Queue complete for repo ${repoId}`);
    return;
  }

  await updateIssueStatus(db, issue.id, "active");

  if (issue.is_manual) {
    const repo = await getRepoById(db, repoId);
    if (repo) {
      await assignHuman(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number,
        repo.owner
      );
      await postIssueComment(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number,
        "👋 Manual task — this requires human action and cannot be completed by the coding agent. Complete the steps above, then close this issue to advance the queue."
      );
    }
  } else {
    const repo = await getRepoById(db, repoId);
    if (repo) {
      await assignCopilot(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number
      );
    }
  }
}

export async function syncWebhooks(
  db: Knex,
  secrets: IAppSecrets,
  baseUrl: string
): Promise<void> {
  const repos = await getActiveRepos(db);

  for (const repo of repos) {
    if (repo.webhook_id == null) {
      try {
        const webhookUrl = `${baseUrl}/api/webhook`;
        const webhookId = await registerWebhook(
          secrets.GH_PAT,
          repo.owner,
          repo.repo_name,
          webhookUrl,
          secrets.WEBHOOK_SECRET
        );
        await updateRepo(db, repo.id, { webhook_id: webhookId });
        console.log(
          `Registered webhook ${webhookId} for ${repo.owner}/${repo.repo_name}`
        );
      } catch (err) {
        console.error(
          `Failed to register webhook for ${repo.owner}/${repo.repo_name}:`,
          err
        );
      }
    }
  }
}
