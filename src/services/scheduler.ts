import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getActiveRepos } from "../db/repos";
import { getNextPendingLeafTask, autoCompleteParentTasks } from "../db/tasks";
import { runTask } from "./taskRunner";

export async function buildWorkQueue(
  db: Knex
): Promise<Array<{ repoId: number; taskId: number }>> {
  const repos = await getActiveRepos(db);
  const queue: Array<{ repoId: number; taskId: number }> = [];

  for (const repo of repos) {
    const task = await getNextPendingLeafTask(db, repo.id);
    if (task) {
      queue.push({ repoId: repo.id, taskId: task.id });
    }
  }

  return queue;
}

let isRunning = false;

export function startScheduler(db: Knex, secrets: IAppSecrets): void {
  if (secrets.IS_WORKER !== "true") {
    console.log("[scheduler] This is not a worker — task execution disabled on this instance.");
    return;
  }
  const parsed = parseInt(secrets.POLL_INTERVAL_SECONDS ?? "300", 10);
  const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : 300;

  async function runCycle(): Promise<void> {
    if (isRunning) {
      console.log("[scheduler] Previous cycle still running, skipping tick.");
      return;
    }
    isRunning = true;
    try {
      const repos = await getActiveRepos(db);
      for (const repo of repos) {
        await autoCompleteParentTasks(db, repo.id);
      }

      const workQueue = await buildWorkQueue(db);

      for (const { repoId, taskId } of workQueue) {
        const result = await runTask(db, secrets, repoId, taskId);
        if (result === "halted") {
          console.log(
            `[scheduler] Task halted for repo ${repoId}, task ${taskId}. Stopping cycle.`
          );
          break;
        }
      }

      console.log(
        `[scheduler] Cycle complete. Next run in ${interval}s`
      );
    } finally {
      isRunning = false;
    }
  }

  runCycle();
  setInterval(runCycle, interval * 1000);
}
