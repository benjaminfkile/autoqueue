import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getIssuesByRepoId, getNextPendingIssue, updateIssueStatus, upsertIssue } from "../db/issues";
import { getActiveRepos, getRepoById, updateRepo } from "../db/repos";
import {
  assignCopilot,
  assignHuman,
  getGithubIssueState,
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

  // Check if this is a container issue (has children in the DB).
  // Container issues (e.g. phase trackers) are not tasks — auto-complete them
  // so the queue moves straight to the first eligible child.
  const childCountResult = await db("issues")
    .where({ repo_id: repoId, parent_issue_number: issue.issue_number })
    .count("id as count")
    .first();
  const hasChildren = parseInt(String(childCountResult?.count ?? "0"), 10) > 0;

  if (hasChildren) {
    console.log(`[advanceQueue] Issue #${issue.issue_number} is a container — auto-completing and advancing`);
    await updateIssueStatus(db, issue.id, "done");
    await advanceQueue(db, secrets, repoId);
    return;
  }

  await updateIssueStatus(db, issue.id, "active");
  console.log(`[advanceQueue] Advancing repo ${repoId} — issue #${issue.issue_number} (id=${issue.id})`);

  if (issue.is_manual) {
    const repo = await getRepoById(db, repoId);
    if (repo) {
      try {
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
          "👋 Manual task — this requires human action and cannot be completed by the coding agent. Complete the steps above when you're ready — the automated queue has already moved on to the next task."
        );
        console.log(`[advanceQueue] Manual issue #${issue.issue_number} — notified and skipping automatically`);
      } catch (err) {
        console.error(`[advanceQueue] Failed to notify manual issue #${issue.issue_number}:`, err);
      }
    }
    // Don't block the queue on manual tasks — mark done immediately and advance
    await updateIssueStatus(db, issue.id, "done");
    await advanceQueue(db, secrets, repoId);
    return;
  }

  const repo = await getRepoById(db, repoId);
  if (repo) {
    try {
      await assignCopilot(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number
      );
      console.log(`[advanceQueue] Copilot assigned to issue #${issue.issue_number}`);
    } catch (err) {
      console.error(`[advanceQueue] Failed to assign Copilot to issue #${issue.issue_number}:`, err);
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

export async function recoverQueues(
  db: Knex,
  secrets: IAppSecrets
): Promise<void> {
  const repos = await getActiveRepos(db);
  for (const repo of repos) {
    try {
      await recoverQueue(db, secrets, repo.id, repo.owner, repo.repo_name);
    } catch (err) {
      console.error(
        `[recoverQueues] Error recovering repo ${repo.owner}/${repo.repo_name}:`,
        err
      );
    }
  }
}

async function recoverQueue(
  db: Knex,
  secrets: IAppSecrets,
  repoId: number,
  owner: string,
  repoName: string
): Promise<void> {
  const issues = await getIssuesByRepoId(db, repoId);
  const activeIssue = issues.find((i) => i.status === "active");

  if (activeIssue) {
    // Manual tasks stuck as active should be skipped — same as the new advanceQueue behavior
    if (activeIssue.is_manual) {
      console.log(
        `[recoverQueue] ${owner}/${repoName}: manual issue #${activeIssue.issue_number} stuck active — marking done and advancing`
      );
      await updateIssueStatus(db, activeIssue.id, "done");
      await advanceQueue(db, secrets, repoId);
      return;
    }

    // For non-manual (Copilot) tasks, check if GitHub already closed the issue
    // (handles missed PR-merged webhooks)
    try {
      const ghState = await getGithubIssueState(
        secrets.GH_PAT,
        owner,
        repoName,
        activeIssue.issue_number
      );
      if (ghState === "closed") {
        console.log(
          `[recoverQueue] ${owner}/${repoName}: issue #${activeIssue.issue_number} is closed on GitHub but active in DB — marking done and advancing`
        );
        await updateIssueStatus(db, activeIssue.id, "done");
        await advanceQueue(db, secrets, repoId);
      }
      // else: issue still open, Copilot is probably still working — no action needed
    } catch (err) {
      console.error(
        `[recoverQueue] ${owner}/${repoName}: failed to check GitHub state for issue #${activeIssue.issue_number}:`,
        err
      );
    }
    return;
  }

  // No active issue — kick the queue if there are pending issues waiting
  const hasPending = issues.some((i) => i.status === "pending");
  if (hasPending) {
    console.log(
      `[recoverQueue] ${owner}/${repoName}: no active issue but pending issues exist — kicking queue`
    );
    await advanceQueue(db, secrets, repoId);
  }
}
