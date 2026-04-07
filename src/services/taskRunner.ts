import { Knex } from "knex";
import { IAppSecrets, Issue, Repo } from "../interfaces";
import { getRepoById } from "../db/repos";
import { updateIssueStatus, updateIssue } from "../db/issues";
import { getIssueDetails, postIssueComment, closeIssue, addIssueLabel, removeIssueLabel, LABEL_WORKING, LABEL_DONE, LABEL_FAILED } from "./github";
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
    secrets.GH_PAT,
    repo.owner,
    repo.repo_name,
    issue.issue_number
  );

  await updateIssueStatus(db, issue.id, "active");

  await postIssueComment(
    secrets.GH_PAT,
    repo.owner,
    repo.repo_name,
    issue.issue_number,
    `🤖 Autoqueue agent starting work on this issue.`
  );
  await addIssueLabel(secrets.GH_PAT, repo.owner, repo.repo_name, issue.issue_number, LABEL_WORKING);

  for (let attempt = issue.retry_count + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await cloneOrPull(secrets.REPOS_PATH, secrets.GH_PAT, repo.owner, repo.repo_name);
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
          secrets.GH_PAT,
          repo.owner,
          repo.repo_name,
          issue.issue_number,
          `fix: complete issue #${issue.issue_number} - ${title}`
        );
      }

      await mergeIntoBase(
        secrets.REPOS_PATH,
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        repo.base_branch,
        issue.issue_number
      );

      await updateIssueStatus(db, issue.id, "done");
      await removeIssueLabel(secrets.GH_PAT, repo.owner, repo.repo_name, issue.issue_number, LABEL_WORKING.name);
      await addIssueLabel(secrets.GH_PAT, repo.owner, repo.repo_name, issue.issue_number, LABEL_DONE);
      await postIssueComment(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number,
        "✅ Completed by autoqueue agent."
      );
      await closeIssue(secrets.GH_PAT, repo.owner, repo.repo_name, issue.issue_number);

      return "success";
    }

    console.error(`[taskRunner] Claude failed on attempt ${attempt} for issue #${issue.issue_number}:\n${claudeOutput}`);

    if (attempt < MAX_ATTEMPTS) {
      await updateIssue(db, issue.id, { retry_count: attempt });
      await postIssueComment(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number,
        `⚠️ Agent failed on attempt ${attempt} of ${MAX_ATTEMPTS}. Retrying...`
      );
    } else {
      await updateIssueStatus(db, issue.id, "failed");
      await removeIssueLabel(secrets.GH_PAT, repo.owner, repo.repo_name, issue.issue_number, LABEL_WORKING.name);
      await addIssueLabel(secrets.GH_PAT, repo.owner, repo.repo_name, issue.issue_number, LABEL_FAILED);
      await postIssueComment(
        secrets.GH_PAT,
        repo.owner,
        repo.repo_name,
        issue.issue_number,
        `❌ Agent failed after ${MAX_ATTEMPTS} attempts. Halting queue. Manual intervention required.`
      );
      return "halted";
    }
  }

  return "halted";
}
