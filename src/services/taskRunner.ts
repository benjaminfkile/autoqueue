import { Knex } from "knex";
import * as path from "path";
import { IAppSecrets, TaskPayload } from "../interfaces";
import * as secrets from "../secrets";
import { getRepoById } from "../db/repos";
import { buildMountManifest } from "./mountManifest";
import {
  getTaskById,
  getChildTasks,
  updateTask,
  getTasksByRepoId,
  renewTaskLease,
} from "../db/tasks";
import { getCriteriaByTaskId } from "../db/acceptanceCriteria";
import { recordEvent } from "../db/taskEvents";
import { createNote, getNotesForTask } from "../db/taskNotes";
import { recordTaskUsage } from "../db/taskUsage";
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
import { triggerWebhooks } from "./webhookDelivery";
import { ensureRunnerImage } from "./imageBuilder";
import { refreshDockerState } from "./dockerProbe";

const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 30 * 60;
const LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;

export async function runTask(
  db: Knex,
  config: IAppSecrets,
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

  // Belt-and-braces guard for the case where a task slipped past the
  // scheduler's Docker probe (e.g. direct invocation in tests, or Docker
  // crashed between the scheduler tick and now). Returning "halted" stops
  // the cycle without burning a retry attempt against the task; once Docker
  // recovers, the next scheduler tick will reclaim and run it.
  const dockerState = await refreshDockerState({ force: true });
  if (!dockerState.available) {
    console.log(
      `[taskRunner] Docker unavailable for task #${taskId} — halting. ${
        dockerState.error ?? ""
      }`.trim()
    );
    return "halted";
  }

  // Make sure the runner image is built before we let the agent start. On the
  // very first task after install this triggers a multi-minute docker build;
  // on subsequent runs it's a fast cache hit (digest unchanged → image
  // already present). Concurrent calls coalesce inside imageBuilder.
  await ensureRunnerImage(db);

  const renewalTimer = setInterval(() => {
    renewTaskLease(db, taskId, LEASE_SECONDS).catch((err) => {
      console.error(
        `[taskRunner] Failed to renew lease for task #${taskId}:`,
        err
      );
    });
  }, LEASE_RENEWAL_INTERVAL_MS);

  try {
    return await runTaskBody(db, config, repoId, task, repo);
  } finally {
    clearInterval(renewalTimer);
  }
}

async function runTaskBody(
  db: Knex,
  config: IAppSecrets,
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

  // 5. Load notes visible to this task per visibility rules
  const notes = await getNotesForTask(db, task.id);

  // 6. Build TaskPayload
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
      notes: notes.map((n) => ({
        id: n.id,
        task_id: n.task_id,
        author: n.author,
        visibility: n.visibility,
        tags: n.tags ?? [],
        content: n.content,
        created_at:
          n.created_at instanceof Date
            ? n.created_at.toISOString()
            : String(n.created_at),
      })),
    },
  };

  // 7. Walk up parent chain, activate pending ancestors
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
    // 8. Git setup (skipped for local folder repos)
    let branchName = "";
    if (!repo.is_local_folder) {
      await cloneOrPull(config.REPOS_PATH, repo.owner!, repo.repo_name!);
      await checkoutBaseBranch(
        config.REPOS_PATH,
        repo.owner!,
        repo.repo_name!,
        repo.base_branch,
        repo.base_branch_parent ?? "main"
      );
      branchName = await createTaskBranch(config.REPOS_PATH, repo.owner!, repo.repo_name!, repo.base_branch, task.id);
      await recordEvent(db, task.id, "branch_created", { branch: branchName });
    }

    // 9. Run Claude
    // Phase 10: the mount manifest carries both the primary workspace and any
    // directly-linked repos under /context/<name>. Built per-attempt so that
    // a repo_links permission change between retries is reflected immediately.
    const mountManifest = await buildMountManifest(db, repo, config.REPOS_PATH);
    const workDir = mountManifest.primary.hostPath;

    await recordEvent(db, task.id, "claude_started", { attempt });
    const logFilePath = path.join(
      config.REPOS_PATH,
      "_logs",
      `task-${task.id}.log`
    );
    const {
      success,
      output: claudeOutput,
      notes: agentNotes = [],
      usage: agentUsage = null,
    } = await runClaudeOnTask({
      workDir,
      taskPayload,
      anthropicApiKey: secrets.get("ANTHROPIC_API_KEY"),
      ghPat: repo.github_token ?? secrets.get("GH_PAT"),
      logFilePath,
      contextMounts: mountManifest.context,
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

    // Persist token usage for every attempt — failed runs cost tokens too, and
    // the per-repo total needs to reflect that. Skipped only when the CLI did
    // not surface usage info (e.g. older output formats), so we don't insert
    // misleading all-zero rows.
    if (agentUsage) {
      try {
        await recordTaskUsage(db, {
          task_id: task.id,
          repo_id: repo.id,
          usage: agentUsage,
        });
      } catch (err) {
        console.error(
          `[taskRunner] Failed to record token usage for task #${task.id}:`,
          err
        );
      }
    }

    if (success) {
      for (const n of agentNotes) {
        try {
          await createNote(db, {
            task_id: task.id,
            author: "agent",
            visibility: n.visibility,
            content: n.content,
            tags: n.tags,
          });
        } catch (err) {
          console.error(
            `[taskRunner] Failed to persist agent note for task #${task.id}:`,
            err
          );
        }
      }
      // 10. On success
      if (repo.is_local_folder) {
        await updateTask(db, task.id, { status: "done" });
        await recordEvent(db, task.id, "status_change", {
          from: task.status,
          to: "done",
        });
        triggerWebhooks(db, repo, { ...task, status: "done" }, "done");
        return "success";
      }

      if (await hasUncommittedChanges(config.REPOS_PATH, repo.owner!, repo.repo_name!)) {
        await commitAndPushTask(
          config.REPOS_PATH,
          repo.owner!,
          repo.repo_name!,
          branchName,
          `feat: complete task #${task.id} - ${task.title}`
        );
        await recordEvent(db, task.id, "commit_pushed", { branch: branchName });
      }

      if (repo.require_pr) {
        const token = repo.github_token ?? secrets.get("GH_PAT")!;
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
        triggerWebhooks(
          db,
          repo,
          { ...task, status: "done", pr_url: pr.url },
          "done"
        );
      } else {
        await mergeTaskIntoBase(
          config.REPOS_PATH,
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
        triggerWebhooks(db, repo, { ...task, status: "done" }, "done");
      }

      return "success";
    }

    // 11/12. On failure
    console.error(`[taskRunner] Claude failed on attempt ${attempt} for task #${task.id}:\n${claudeOutput}`);

    if (attempt < MAX_ATTEMPTS) {
      await updateTask(db, task.id, { retry_count: attempt });
      await recordEvent(db, task.id, "retry", {
        attempt,
        next_attempt: attempt + 1,
      });
      triggerWebhooks(db, repo, task, "failed");
      return "failed";
    } else {
      await updateTask(db, task.id, { status: "failed" });
      await recordEvent(db, task.id, "failed", { attempt });
      await recordEvent(db, task.id, "status_change", {
        from: task.status,
        to: "failed",
      });
      triggerWebhooks(db, repo, { ...task, status: "failed" }, "halted");
      return "halted";
    }
  }

  return "halted";
}
