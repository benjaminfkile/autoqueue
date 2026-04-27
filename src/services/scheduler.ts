import { Knex } from "knex";
import * as os from "os";
import { IAppSecrets } from "../interfaces";
import { getActiveRepos } from "../db/repos";
import { claimNextPendingLeafTask, autoCompleteParentTasks } from "../db/tasks";
import { recordEvent } from "../db/taskEvents";
import { runTask } from "./taskRunner";
import { refreshDockerState } from "./dockerProbe";
import { getWeeklyTokens } from "../db/usageAggregations";
import { getSettings } from "../db/settings";

const LEASE_SECONDS = 30 * 60;

export const WORKER_ID = `${os.hostname()}:${process.pid}`;

// Snapshot of the current weekly-cap evaluation. The scheduler refreshes this
// every time it considers claiming a task, and the systemRouter exposes the
// fresh value via GET /api/system/capped so the SPA can render a banner /
// disable controls without polling the worker over a side channel.
export interface CapStatus {
  capped: boolean;
  weekly_total: number;
  weekly_cap: number | null;
}

// Re-reads the weekly cap and the trailing-7-day token total in one call. A
// null cap means "unlimited" → never capped, regardless of usage. The check
// is `>=` (not `>`) so once usage hits the cap exactly we stop claiming —
// matching the chat-router check (sibling task #329) which uses the same
// threshold to block new turns.
export async function evaluateCapStatus(
  db: Knex,
  now: Date = new Date()
): Promise<CapStatus> {
  const settings = await getSettings(db);
  const cap = settings.weekly_token_cap;
  const usage = await getWeeklyTokens(db, now);
  return {
    capped: cap !== null && usage.total >= cap,
    weekly_total: usage.total,
    weekly_cap: cap,
  };
}

export async function buildWorkQueue(
  db: Knex,
  workerId: string = WORKER_ID,
  leaseSeconds: number = LEASE_SECONDS
): Promise<Array<{ repoId: number; taskId: number }>> {
  const repos = await getActiveRepos(db);
  const queue: Array<{ repoId: number; taskId: number }> = [];

  for (const repo of repos) {
    // Re-check the weekly cap before each claim so a cycle that crosses the
    // threshold partway through stops claiming new work mid-loop. In-flight
    // tasks are unaffected — runTask runs after this loop returns and we
    // never preempt a running task here.
    const status = await evaluateCapStatus(db);
    if (status.capped) {
      console.log(
        `[scheduler] capped — weekly tokens ${status.weekly_total} >= cap ${status.weekly_cap}. Skipping new claims until next cycle.`
      );
      break;
    }

    const task = await claimNextPendingLeafTask(db, repo.id, workerId, leaseSeconds);
    if (task) {
      await recordEvent(db, task.id, "claimed", { worker_id: workerId });
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
      // Probe Docker before doing any task work. If Docker isn't reachable,
      // every task would fail at `docker run` time anyway, so we pause the
      // worker (skip the tick) rather than burn through retry budgets while
      // the daemon is down. The next tick re-probes; once Docker is back the
      // scheduler resumes automatically with no operator intervention.
      const dockerState = await refreshDockerState({ force: true });
      if (!dockerState.available) {
        console.log(
          `[scheduler] Docker unavailable — pausing worker. ${
            dockerState.error ?? ""
          }`.trim()
        );
        return;
      }

      const repos = await getActiveRepos(db);
      for (const repo of repos) {
        await autoCompleteParentTasks(db, repo.id, repo.on_parent_child_fail);
      }

      const workQueue = await buildWorkQueue(db, WORKER_ID, LEASE_SECONDS);

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
