import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { Issue } from "../db/issues";
import { getRepoById } from "../db/repos";
import { updateIssueStatus, updateIssue } from "../db/issues";
import { getIssueDetails, postIssueComment, closeIssue, addIssueLabel, removeIssueLabel, LABEL_WORKING, LABEL_DONE, LABEL_FAILED } from "./githubLegacy";
import {
  cloneOrPull,
  checkoutBaseBranch,
  createIssueBranch,
  commitAndPush,
  mergeIntoBase,
  hasUncommittedChanges,
} from "./git";
import { runClaudeOnIssue } from "./claudeRunner";

const MAX_ATTEMPTS = 3;

async function tryGithubAction(fn: () => Promise<void>, description: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[taskRunner] GitHub action failed (${description}):`, (err as Error).message);
  }
}

export async function runTask(
  db: Knex,
  secrets: IAppSecrets,
  repoId: number,
  issueId: number
): Promise<"success" | "failed" | "halted"> {
  const issue = await db<Issue>("issues").where({ id: issueId }).first();
  const repo = await getRepoById(db, repoId);

  if (!issue || !repo) {
    console.error(`[taskRunner] Missing issue (${issueId}) or repo (${repoId})`);
    return "failed";
  }

  const { title, body } = await getIssueDetails(
    secrets.GITHUB_TOKEN!,
    repo.owner,
    repo.repo_name,
    issue.issue_number
  );

  await updateIssueStatus(db, issue.id, "active");

  if (issue.retry_count === 0) {
    await tryGithubAction(
      () => postIssueComment(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, `🤖 grunt agent starting work on this issue.`),
      "post start comment"
    );
  }
  await tryGithubAction(
    () => addIssueLabel(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, LABEL_WORKING),
    "add working label"
  );

  for (let attempt = issue.retry_count + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await cloneOrPull(secrets.REPOS_PATH, secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name);
    await checkoutBaseBranch(secrets.REPOS_PATH, repo.owner, repo.repo_name, repo.base_branch);
    await createIssueBranch(
      secrets.REPOS_PATH,
      repo.owner,
      repo.repo_name,
      repo.base_branch,
      issue.issue_number
    );

    const { success, output: claudeOutput } = await runClaudeOnIssue({
      reposPath: secrets.REPOS_PATH,
      owner: repo.owner,
      repoName: repo.repo_name,
      issueNumber: issue.issue_number,
      issueTitle: title,
      issueBody: body,
      anthropicApiKey: secrets.ANTHROPIC_API_KEY,
      claudePath: secrets.CLAUDE_PATH,
    });

    if (success) {
      if (
        await hasUncommittedChanges(secrets.REPOS_PATH, repo.owner, repo.repo_name)
      ) {
        await commitAndPush(
          secrets.REPOS_PATH,
          secrets.GITHUB_TOKEN!,
          repo.owner,
          repo.repo_name,
          issue.issue_number,
          `fix: complete issue #${issue.issue_number} - ${title}`
        );
      }

      await mergeIntoBase(
        secrets.REPOS_PATH,
        secrets.GITHUB_TOKEN!,
        repo.owner,
        repo.repo_name,
        repo.base_branch,
        issue.issue_number
      );

      await updateIssueStatus(db, issue.id, "done");
      await tryGithubAction(() => removeIssueLabel(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, LABEL_WORKING.name), "remove working label");
      await tryGithubAction(() => addIssueLabel(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, LABEL_DONE), "add done label");
      await tryGithubAction(() => postIssueComment(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, "✅ Completed by grunt agent."), "post done comment");
      await tryGithubAction(() => closeIssue(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number), "close issue");

      return "success";
    }

    console.error(`[taskRunner] Claude failed on attempt ${attempt} for issue #${issue.issue_number}:\n${claudeOutput}`);

    if (attempt < MAX_ATTEMPTS) {
      await updateIssue(db, issue.id, { retry_count: attempt });
      await tryGithubAction(() => postIssueComment(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, `⚠️ Agent failed on attempt ${attempt} of ${MAX_ATTEMPTS}. Retrying...`), "post retry comment");
    } else {
      await updateIssueStatus(db, issue.id, "failed");
      await tryGithubAction(() => removeIssueLabel(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, LABEL_WORKING.name), "remove working label");
      await tryGithubAction(() => addIssueLabel(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, LABEL_FAILED), "add failed label");
      await tryGithubAction(() => postIssueComment(secrets.GITHUB_TOKEN!, repo.owner, repo.repo_name, issue.issue_number, `❌ Agent failed after ${MAX_ATTEMPTS} attempts. Halting queue. Manual intervention required.`), "post failed comment");
      return "halted";
    }
  }

  return "halted";
}
