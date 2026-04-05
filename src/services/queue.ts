import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getIssuesByRepoId, getNextPendingIssue, updateIssueStatus, upsertIssue } from "../db/issues";
import { getActiveRepos, getRepoById, updateRepo } from "../db/repos";
import {
  assignCopilot,
  assignHuman,
  getOpenIssues,
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

export async function backfillIssues(
  db: Knex,
  secrets: IAppSecrets,
  repoId: number
): Promise<void> {
  const repo = await getRepoById(db, repoId);
  if (!repo) {
    console.error(`backfillIssues: repo ${repoId} not found`);
    return;
  }

  const ghIssues = await getOpenIssues(secrets.GH_PAT, repo.owner, repo.repo_name);

  // GitHub's issues API also returns pull requests — filter them out
  const openIssues = ghIssues.filter((i) => !i.pull_request);

  if (openIssues.length === 0) {
    console.log(`No open issues to backfill for ${repo.owner}/${repo.repo_name}`);
    return;
  }

  // Sort ascending by issue number so queue_position reflects creation order
  openIssues.sort((a, b) => a.number - b.number);

  // Find the current max queue_position so we append after any existing entries
  const existing = await getIssuesByRepoId(db, repoId);
  const maxPos = existing.reduce((max, i) => Math.max(max, i.queue_position), 0);

  let position = maxPos;
  let inserted = 0;
  let skipped = 0;

  for (const ghIssue of openIssues) {
    const alreadyExists = existing.some((i) => i.issue_number === ghIssue.number);
    if (alreadyExists) {
      skipped++;
      continue;
    }

    position++;
    const isManual = ghIssue.labels.some(
      (l) => (typeof l === "string" ? l : l.name)?.toLowerCase() === "manual"
    );

    const parentIssueUrl: string | null =
      (ghIssue as unknown as { parent_issue_url?: string | null }).parent_issue_url ?? null;
    const parentUrlMatch = parentIssueUrl?.match(/\/(\d+)$/);
    const parentIssueNumber = parentUrlMatch ? parseInt(parentUrlMatch[1], 10) : null;

    await upsertIssue(db, {
      repo_id: repoId,
      issue_number: ghIssue.number,
      parent_issue_number: parentIssueNumber,
      queue_position: position,
      is_manual: isManual,
    });
    inserted++;
  }

  console.log(
    `Backfill complete for ${repo.owner}/${repo.repo_name}: ${inserted} inserted, ${skipped} already existed`
  );

  // Kick off the queue in case nothing is currently active
  await advanceQueue(db, secrets, repoId);
}
