import { Knex } from "knex";
import { IAppSecrets } from "../interfaces";
import { getActiveRepos } from "../db/repos";
import { getNextPendingIssue, autoCompleteContainers } from "../db/issues";
import { syncIssues } from "./issueSync";
import { runTask } from "./taskRunner";

export async function buildWorkQueue(
  db: Knex,
  secrets: IAppSecrets
): Promise<Array<{ repoId: number; issueId: number }>> {
  const repos = await getActiveRepos(db);
  const queue: Array<{ repoId: number; issueId: number }> = [];

  for (const repo of repos) {
    const issue = await getNextPendingIssue(db, repo.id);
    if (issue) {
      queue.push({ repoId: repo.id, issueId: issue.id });
    }
  }

  return queue;
}

let isRunning = false;

export function startScheduler(db: Knex, secrets: IAppSecrets): void {
  const parsed = parseInt(secrets.POLL_INTERVAL_SECONDS ?? "300", 10);
  const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : 300;

  async function runCycle(): Promise<void> {
    if (isRunning) {
      console.log("[scheduler] Previous cycle still running, skipping tick.");
      return;
    }
    isRunning = true;
    try {
      await syncIssues(db, secrets);

      const repos = await getActiveRepos(db);
      for (const repo of repos) {
        await autoCompleteContainers(db, repo.id);
      }

      const workQueue = await buildWorkQueue(db, secrets);

      for (const { repoId, issueId } of workQueue) {
        const result = await runTask(db, secrets, repoId, issueId);
        if (result === "halted") {
          console.log(
            `[scheduler] Task halted for repo ${repoId}, issue ${issueId}. Stopping cycle.`
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
