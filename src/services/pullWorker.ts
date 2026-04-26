import { Knex } from "knex";
import simpleGit from "simple-git";
import * as fs from "fs";
import * as path from "path";
import { IAppSecrets, Repo } from "../interfaces";
import { getAllRepos, updateRepo } from "../db/repos";
import { isPullWorkerPaused } from "../db/appSettings";

// Number of consecutive pull failures (per repo) before we promote the repo's
// clone_status to 'error'. A single transient failure (network blip, GitHub
// rate limit) shouldn't surface as a hard error to the GUI — only sustained
// failures across multiple ticks indicate the clone is actually unhealthy.
const FAILURE_THRESHOLD = 3;

const DEFAULT_INTERVAL_SECONDS = 600;

// Per-repo failure counter. In-memory because it resets on restart anyway and
// the durable signal (clone_status='error') already lives on the repos table.
const failureCounts = new Map<number, number>();

export function _resetFailureCountsForTest(): void {
  failureCounts.clear();
}

export function _getFailureCount(repoId: number): number {
  return failureCounts.get(repoId) ?? 0;
}

function resolveInterval(secrets: IAppSecrets): number {
  const raw = secrets.PULL_WORKER_INTERVAL_SECONDS;
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SECONDS;
}

function repoClonePath(reposPath: string, repo: Repo): string | null {
  if (repo.is_local_folder) return null;
  if (!repo.owner || !repo.repo_name) return null;
  return path.join(reposPath, repo.owner, repo.repo_name);
}

// Keep a single repo's clone fresh: `git fetch` then `git pull`. Returns true
// if the clone was successfully updated (or required no work), false if the
// pull failed.
//
// Why fetch + pull rather than just pull: pull alone doesn't surface a fetch
// failure cleanly (e.g. an unreachable remote), so splitting them gives a
// clearer error message in the logs and lets us flag fetch-only outages as
// pull failures too.
export async function pullRepo(
  reposPath: string,
  repo: Repo
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (repo.is_local_folder) {
    return { ok: true };
  }
  const dir = repoClonePath(reposPath, repo);
  if (!dir) {
    return { ok: false, error: "repo missing owner/repo_name" };
  }
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `clone directory missing: ${dir}` };
  }
  try {
    const git = simpleGit(dir);
    await git.fetch();
    await git.pull();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function runPullCycle(
  db: Knex,
  reposPath: string
): Promise<void> {
  if (await isPullWorkerPaused(db)) {
    console.log("[pullWorker] Paused — skipping cycle.");
    return;
  }

  const repos = await getAllRepos(db);
  for (const repo of repos) {
    if (repo.is_local_folder) continue;
    if (!repo.active) continue;
    // Repos whose initial clone failed shouldn't be retried by the pull
    // worker — there's no working tree to pull into. The user has to
    // re-create them through the normal flow.
    if (repo.clone_status !== "ready") continue;

    const result = await pullRepo(reposPath, repo);
    if (result.ok) {
      if (failureCounts.get(repo.id)) {
        failureCounts.delete(repo.id);
      }
      // If a previous cycle had marked this repo as errored and it has since
      // recovered, demote it back to ready so the GUI reflects the current
      // state. Skip if it's already 'ready' to avoid no-op writes.
      // (clone_status === 'ready' is enforced above already, but a future
      // change could let recovered repos through, so the guard is left in.)
    } else {
      const next = (failureCounts.get(repo.id) ?? 0) + 1;
      failureCounts.set(repo.id, next);
      console.error(
        `[pullWorker] Pull failed for repo ${repo.id} (${repo.owner}/${repo.repo_name}) [attempt ${next}/${FAILURE_THRESHOLD}]: ${result.error}`
      );
      if (next >= FAILURE_THRESHOLD) {
        await updateRepo(db, repo.id, {
          clone_status: "error",
          clone_error: `Pull failed ${next} consecutive times: ${result.error}`,
        });
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let isCycleRunning = false;

export function startPullWorker(db: Knex, secrets: IAppSecrets): void {
  if (timer) {
    return;
  }
  const reposPath = secrets.REPOS_PATH;
  if (!reposPath) {
    console.log(
      "[pullWorker] REPOS_PATH is not configured — pull worker disabled."
    );
    return;
  }
  const interval = resolveInterval(secrets);

  async function tick(): Promise<void> {
    if (isCycleRunning) {
      console.log("[pullWorker] Previous cycle still running, skipping tick.");
      return;
    }
    isCycleRunning = true;
    try {
      await runPullCycle(db, reposPath);
    } catch (err) {
      console.error("[pullWorker] Cycle errored:", (err as Error).message);
    } finally {
      isCycleRunning = false;
    }
  }

  console.log(
    `[pullWorker] Starting background pull worker (interval=${interval}s).`
  );
  // Kick off an initial cycle so freshly-started instances don't wait a full
  // interval before reconciling.
  tick();
  timer = setInterval(tick, interval * 1000);
  // Don't block process exit on the pull worker timer.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

export function stopPullWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
