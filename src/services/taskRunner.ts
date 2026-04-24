import { Knex } from "knex";
import * as path from "path";
import { IAppSecrets, TaskPayload } from "../interfaces";
import { getRepoById } from "../db/repos";
import { getTaskById, getChildTasks, updateTask, getTasksByRepoId } from "../db/tasks";
import { getCriteriaByTaskId } from "../db/acceptanceCriteria";
import {
  cloneOrPull,
  checkoutBaseBranch,
  createTaskBranch,
  commitAndPushTask,
  mergeTaskIntoBase,
  hasUncommittedChanges,
} from "./git";
import { createPullRequest } from "./github";
import { runClaudeOnTask } from "./claudeRunner";

const MAX_ATTEMPTS = 3;

export async function runTask(
  db: Knex,
  secrets: IAppSecrets,
  repoId: number,
  taskId: number
): Promise<"success" | "failed" | "halted"> {
  // 1. Load task and repo
  const task = await getTaskById(db, taskId);
  const repo = await getRepoById(db, repoId);

  if (!task || !repo) {
    console.error(`[taskRunner] Missing task (${taskId}) or repo (${repoId})`);
    return "failed";
  }

  // 2. Load acceptance criteria
  const criteria = await getCriteriaByTaskId(db, task.id);

  // 3. Load parent task
  const parent = task.parent_id != null ? await getTaskById(db, task.parent_id) : null;

  // 4. Load siblings
  let siblings;
  if (task.parent_id != null) {
    siblings = await getChildTasks(db, task.parent_id);
  } else {
    const allTasks = await getTasksByRepoId(db, repoId);
    siblings = allTasks.filter((t) => t.parent_id == null);
  }
  siblings = siblings.filter((t) => t.id !== task.id);

  // 5. Build TaskPayload
  const taskPayload: TaskPayload = {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      acceptanceCriteria: criteria.map((c) => ({
        id: c.id,
        description: c.description,
        met: c.met,
      })),
      parent: parent
        ? { id: parent.id, title: parent.title, description: parent.description }
        : null,
      siblings: siblings.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        order_position: s.order_position,
      })),
    },
  };

  // 6. Set task status to active
  await updateTask(db, task.id, { status: "active" });

  // 7. Walk up parent chain, activate pending ancestors
  let ancestorId = task.parent_id;
  while (ancestorId != null) {
    const ancestor = await getTaskById(db, ancestorId);
    if (!ancestor) break;
    if (ancestor.status === "pending") {
      await updateTask(db, ancestor.id, { status: "active" });
    }
    ancestorId = ancestor.parent_id;
  }

  for (let attempt = task.retry_count + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 8. Git setup
    await cloneOrPull(secrets.REPOS_PATH, secrets.GH_PAT!, repo.owner, repo.repo_name);
    await checkoutBaseBranch(secrets.REPOS_PATH, repo.owner, repo.repo_name, repo.base_branch);
    await createTaskBranch(secrets.REPOS_PATH, repo.owner, repo.repo_name, repo.base_branch, task.id);

    // 9. Run Claude
    const workDir = repo.is_local_folder
      ? repo.local_path!
      : path.join(secrets.REPOS_PATH, repo.owner!, repo.repo_name!);

    const { success, output: claudeOutput } = await runClaudeOnTask({
      workDir,
      taskPayload,
      anthropicApiKey: secrets.ANTHROPIC_API_KEY,
      claudePath: secrets.CLAUDE_PATH,
    });

    if (success) {
      // 10. On success
      if (await hasUncommittedChanges(secrets.REPOS_PATH, repo.owner, repo.repo_name)) {
        await commitAndPushTask(
          secrets.REPOS_PATH,
          secrets.GH_PAT!,
          repo.owner,
          repo.repo_name,
          task.id,
          `feat: complete task #${task.id} - ${task.title}`
        );
      }

      if (repo.require_pr) {
        const token = repo.github_token ?? secrets.GH_PAT!;
        const criteriaList = criteria
          .map((c) => `- [${c.met ? "x" : " "}] ${c.description}`)
          .join("\n");
        const body = `${task.description}\n\n## Acceptance Criteria\n${criteriaList}`;

        const pr = await createPullRequest({
          token,
          owner: repo.owner,
          repoName: repo.repo_name,
          head: `task/${task.id}`,
          base: repo.base_branch,
          title: task.title,
          body,
        });

        await updateTask(db, task.id, { status: "done", pr_url: pr.url });
      } else {
        await mergeTaskIntoBase(
          secrets.REPOS_PATH,
          secrets.GH_PAT!,
          repo.owner,
          repo.repo_name,
          repo.base_branch,
          task.id
        );
        await updateTask(db, task.id, { status: "done" });
      }

      return "success";
    }

    // 11/12. On failure
    console.error(`[taskRunner] Claude failed on attempt ${attempt} for task #${task.id}:\n${claudeOutput}`);

    if (attempt < MAX_ATTEMPTS) {
      await updateTask(db, task.id, { retry_count: attempt });
      return "failed";
    } else {
      await updateTask(db, task.id, { status: "failed" });
      return "halted";
    }
  }

  return "halted";
}
