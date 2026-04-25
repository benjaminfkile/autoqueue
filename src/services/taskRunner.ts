import { Knex } from "knex";
import * as path from "path";
import { IAppSecrets, TaskPayload } from "../interfaces";
import { getRepoById } from "../db/repos";
import {
  getTaskById,
  getChildTasks,
  updateTask,
  getTasksByRepoId,
  renewTaskLease,
} from "../db/tasks";
import { getCriteriaByTaskId } from "../db/acceptanceCriteria";
import { recordEvent } from "../db/taskEvents";
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
const LEASE_SECONDS = 30 * 60;
const LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;

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

  const renewalTimer = setInterval(() => {
    renewTaskLease(db, taskId, LEASE_SECONDS).catch((err) => {
      console.error(
        `[taskRunner] Failed to renew lease for task #${taskId}:`,
        err
      );
    });
  }, LEASE_RENEWAL_INTERVAL_MS);

  try {
    return await runTaskBody(db, secrets, repoId, task, repo);
  } finally {
    clearInterval(renewalTimer);
  }
}

async function runTaskBody(
  db: Knex,
  secrets: IAppSecrets,
  repoId: number,
  task: NonNullable<Awaited<ReturnType<typeof getTaskById>>>,
  repo: NonNullable<Awaited<ReturnType<typeof getRepoById>>>
): Promise<"success" | "failed" | "halted"> {
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

  // 6. Walk up parent chain, activate pending ancestors
  let ancestorId = task.parent_id;
  while (ancestorId != null) {
    const ancestor = await getTaskById(db, ancestorId);
    if (!ancestor) break;
    if (ancestor.status === "pending") {
      await updateTask(db, ancestor.id, { status: "active" });
      await recordEvent(db, ancestor.id, "status_change", {
        from: "pending",
        to: "active",
      });
    }
    ancestorId = ancestor.parent_id;
  }

  for (let attempt = task.retry_count + 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 7. Git setup (skipped for local folder repos)
    let branchName = "";
    if (!repo.is_local_folder) {
      await cloneOrPull(secrets.REPOS_PATH, secrets.GH_PAT!, repo.owner!, repo.repo_name!);
      await checkoutBaseBranch(
        secrets.REPOS_PATH,
        repo.owner!,
        repo.repo_name!,
        repo.base_branch,
        repo.base_branch_parent ?? "main"
      );
      branchName = await createTaskBranch(secrets.REPOS_PATH, repo.owner!, repo.repo_name!, repo.base_branch, task.id);
      await recordEvent(db, task.id, "branch_created", { branch: branchName });
    }

    // 8. Run Claude
    const workDir = repo.is_local_folder
      ? repo.local_path!
      : path.join(secrets.REPOS_PATH, repo.owner!, repo.repo_name!);

    await recordEvent(db, task.id, "claude_started", { attempt });
    const logFilePath = path.join(
      secrets.REPOS_PATH,
      "_logs",
      `task-${task.id}.log`
    );
    const { success, output: claudeOutput } = await runClaudeOnTask({
      workDir,
      taskPayload,
      anthropicApiKey: secrets.ANTHROPIC_API_KEY,
      claudePath: secrets.CLAUDE_PATH,
      logFilePath,
      onFirstByte: () => {
        updateTask(db, task.id, { log_path: logFilePath }).catch((err) => {
          console.error(
            `[taskRunner] Failed to set log_path for task #${task.id}:`,
            err
          );
        });
      },
    });
    await recordEvent(db, task.id, "claude_finished", { attempt, success });

    if (success) {
      // 9. On success
      if (repo.is_local_folder) {
        await updateTask(db, task.id, { status: "done" });
        await recordEvent(db, task.id, "status_change", {
          from: task.status,
          to: "done",
        });
        return "success";
      }

      if (await hasUncommittedChanges(secrets.REPOS_PATH, repo.owner!, repo.repo_name!)) {
        await commitAndPushTask(
          secrets.REPOS_PATH,
          secrets.GH_PAT!,
          repo.owner!,
          repo.repo_name!,
          branchName,
          `feat: complete task #${task.id} - ${task.title}`
        );
        await recordEvent(db, task.id, "commit_pushed", { branch: branchName });
      }

      if (repo.require_pr) {
        const token = repo.github_token ?? secrets.GH_PAT!;
        const criteriaList = criteria
          .map((c) => `- [${c.met ? "x" : " "}] ${c.description}`)
          .join("\n");
        const body = `${task.description}\n\n## Acceptance Criteria\n${criteriaList}`;

        const pr = await createPullRequest({
          token,
          owner: repo.owner!,
          repoName: repo.repo_name!,
          head: branchName,
          base: repo.base_branch,
          title: task.title,
          body,
        });

        await updateTask(db, task.id, { status: "done", pr_url: pr.url });
        await recordEvent(db, task.id, "pr_opened", { url: pr.url });
        await recordEvent(db, task.id, "status_change", {
          from: task.status,
          to: "done",
        });
      } else {
        await mergeTaskIntoBase(
          secrets.REPOS_PATH,
          secrets.GH_PAT!,
          repo.owner!,
          repo.repo_name!,
          repo.base_branch,
          branchName
        );
        await updateTask(db, task.id, { status: "done" });
        await recordEvent(db, task.id, "status_change", {
          from: task.status,
          to: "done",
        });
      }

      return "success";
    }

    // 10/11. On failure
    console.error(`[taskRunner] Claude failed on attempt ${attempt} for task #${task.id}:\n${claudeOutput}`);

    if (attempt < MAX_ATTEMPTS) {
      await updateTask(db, task.id, { retry_count: attempt });
      await recordEvent(db, task.id, "retry", {
        attempt,
        next_attempt: attempt + 1,
      });
      return "failed";
    } else {
      await updateTask(db, task.id, { status: "failed" });
      await recordEvent(db, task.id, "failed", { attempt });
      await recordEvent(db, task.id, "status_change", {
        from: task.status,
        to: "failed",
      });
      return "halted";
    }
  }

  return "halted";
}
