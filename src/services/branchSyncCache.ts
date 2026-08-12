import { Knex } from "knex";
import { Repo } from "../interfaces";
import { getAllRepos } from "../db/repos";
import { getBranchAheadBehind } from "./git";

// Per-repo base_branch vs base_branch_parent sync snapshot. `state` collapses
// the ahead/behind counts into the four states the GUI badge cares about so
// the UI doesn't have to reimplement the same branching over and over. When
// the local clone is missing or the refs can't be resolved we hold `unknown`
// with null counts — the caller must not assume 0/0 means "synced".
export type BranchSyncState = "synced" | "ahead" | "behind" | "diverged" | "unknown";

export interface BranchSyncSnapshot {
  branch_ahead: number | null;
  branch_behind: number | null;
  branch_sync_state: BranchSyncState;
  branch_sync_checked_at: string | null;
}

// In-memory cache. Git ops are slow (seconds per repo) and the repos list
// polls every few seconds — running `rev-list` on every GET would grind the
// UI. Snapshots are computed on a background refresh (task #31, part 3) and
// reused between GET /api/repos calls until the next refresh cycle.
//
// Keyed by repo id; the process is single-node (grunt runs one server), so a
// module-scoped Map is enough — no cross-process invalidation to worry about.
const cache = new Map<number, BranchSyncSnapshot>();

export function _resetBranchSyncCacheForTest(): void {
  cache.clear();
}

const UNKNOWN_SNAPSHOT: BranchSyncSnapshot = {
  branch_ahead: null,
  branch_behind: null,
  branch_sync_state: "unknown",
  branch_sync_checked_at: null,
};

export function getBranchSyncSnapshot(repoId: number): BranchSyncSnapshot {
  return cache.get(repoId) ?? UNKNOWN_SNAPSHOT;
}

// Refresh a single repo's snapshot: skip local-folder / missing-clone repos
// (nothing to compare), otherwise shell out to git.getBranchAheadBehind and
// store the result. Never throws — a failure degrades to an 'unknown'
// snapshot with the current timestamp so the UI can still tell the check
// ran but couldn't produce a result.
export async function refreshBranchSyncForRepo(
  reposPath: string,
  repo: Repo
): Promise<BranchSyncSnapshot> {
  const nowIso = new Date().toISOString();

  if (repo.is_local_folder) {
    const snap: BranchSyncSnapshot = {
      ...UNKNOWN_SNAPSHOT,
      branch_sync_checked_at: nowIso,
    };
    cache.set(repo.id, snap);
    return snap;
  }
  if (!repo.owner || !repo.repo_name) {
    const snap: BranchSyncSnapshot = {
      ...UNKNOWN_SNAPSHOT,
      branch_sync_checked_at: nowIso,
    };
    cache.set(repo.id, snap);
    return snap;
  }
  if (repo.clone_status !== "ready") {
    const snap: BranchSyncSnapshot = {
      ...UNKNOWN_SNAPSHOT,
      branch_sync_checked_at: nowIso,
    };
    cache.set(repo.id, snap);
    return snap;
  }

  let counts: Awaited<ReturnType<typeof getBranchAheadBehind>> = null;
  try {
    counts = await getBranchAheadBehind(
      reposPath,
      repo.owner,
      repo.repo_name,
      repo.base_branch,
      repo.base_branch_parent
    );
  } catch {
    counts = null;
  }

  let snap: BranchSyncSnapshot;
  if (counts === null) {
    snap = { ...UNKNOWN_SNAPSHOT, branch_sync_checked_at: nowIso };
  } else {
    const state: BranchSyncState =
      counts.ahead === 0 && counts.behind === 0
        ? "synced"
        : counts.ahead > 0 && counts.behind === 0
          ? "ahead"
          : counts.ahead === 0 && counts.behind > 0
            ? "behind"
            : "diverged";
    snap = {
      branch_ahead: counts.ahead,
      branch_behind: counts.behind,
      branch_sync_state: state,
      branch_sync_checked_at: nowIso,
    };
  }
  cache.set(repo.id, snap);
  return snap;
}

// Refresh every repo in the DB. Serial (not parallel) on purpose: git ops
// against different clones don't conflict, but a large repo count could
// spawn many concurrent shell processes and slow the machine — the
// dashboard doesn't need sub-second freshness, so we trade a little wall
// clock for stability.
export async function refreshAllBranchSync(
  db: Knex,
  reposPath: string
): Promise<void> {
  const repos = await getAllRepos(db);
  for (const repo of repos) {
    await refreshBranchSyncForRepo(reposPath, repo);
  }
}

// Drop a cached entry — used when a repo is deleted so the map doesn't leak
// snapshots for gone-away ids.
export function forgetBranchSyncSnapshot(repoId: number): void {
  cache.delete(repoId);
}

let timer: NodeJS.Timeout | null = null;
let isCycleRunning = false;

const DEFAULT_INTERVAL_SECONDS = 300;

// Kick off a background refresh loop. Runs an initial cycle immediately so
// a freshly-booted server has snapshots on first paint, then repeats every
// BRANCH_SYNC_INTERVAL_SECONDS (default 5 minutes). Skips ticks while a
// prior cycle is still in flight so a slow repo can't queue up work.
export function startBranchSyncRefresher(
  db: Knex,
  reposPath: string,
  intervalSecondsOverride?: number
): void {
  if (timer) return;
  if (!reposPath) {
    console.log(
      "[branchSync] REPOS_PATH is not configured — branch sync refresher disabled."
    );
    return;
  }

  const envVal = parseInt(
    process.env.BRANCH_SYNC_INTERVAL_SECONDS ?? "",
    10
  );
  const interval =
    intervalSecondsOverride ??
    (Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_INTERVAL_SECONDS);

  const tick = async (): Promise<void> => {
    if (isCycleRunning) {
      return;
    }
    isCycleRunning = true;
    try {
      await refreshAllBranchSync(db, reposPath);
    } catch (err) {
      console.error(
        "[branchSync] Refresh cycle errored:",
        (err as Error).message
      );
    } finally {
      isCycleRunning = false;
    }
  };

  console.log(
    `[branchSync] Starting background branch-sync refresher (interval=${interval}s).`
  );
  void tick();
  timer = setInterval(() => {
    void tick();
  }, interval * 1000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

export function stopBranchSyncRefresher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
