import type { BranchSyncState, Repo, TaskStatus, TaskSummary } from "../../api/types";

export const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "active",
  "done",
  "failed",
  "interrupted",
];

export type RepoStatusCounts = Record<TaskStatus, number>;

export function repoDisplayName(repo: Repo): string {
  if (repo.is_local_folder && repo.local_path) {
    return repo.local_path;
  }
  if (repo.owner && repo.repo_name) {
    return `${repo.owner}/${repo.repo_name}`;
  }
  if (repo.repo_name) return repo.repo_name;
  if (repo.local_path) return repo.local_path;
  return `Repo #${repo.id}`;
}

export function emptyCounts(): RepoStatusCounts {
  return { pending: 0, active: 0, done: 0, failed: 0, interrupted: 0 };
}

export const TASK_STATUS_CHIP_COLOR: Record<
  TaskStatus,
  "default" | "primary" | "success" | "error" | "warning"
> = {
  pending: "default",
  active: "primary",
  done: "success",
  failed: "error",
  interrupted: "warning",
};

export function countTasksByStatus(tasks: TaskSummary[]): RepoStatusCounts {
  const counts = emptyCounts();
  for (const task of tasks) {
    if (task.status in counts) {
      counts[task.status] += 1;
    }
  }
  return counts;
}

export function lastActivityIso(tasks: TaskSummary[]): string | null {
  let latest: number | null = null;
  for (const task of tasks) {
    const ts = Date.parse(task.created_at);
    if (Number.isFinite(ts) && (latest === null || ts > latest)) {
      latest = ts;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function formatLastActivity(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return date.toLocaleDateString();
}

// Ordered from most-recent to least. Used both to pick the activity-heat
// colour and to describe the intensity in aria/text labels so the visual and
// non-visual cues stay in sync.
export type ActivityHeatLevel =
  | "very-hot"
  | "hot"
  | "warm"
  | "cool"
  | "cold"
  | "dormant"
  | "none";

export interface ActivityHeat {
  level: ActivityHeatLevel;
  color: string;
  label: string;
  tooltip: string;
}

// Thresholds picked to match how Ben reads the dashboard: "within a day" is
// clearly warm, a couple of days is neutral, past a fortnight is cold, past a
// month is dormant. The palette runs warm→neutral→grey so the eye picks up
// hot repos first and cold ones fade back.
const HEAT_COLORS: Record<ActivityHeatLevel, string> = {
  "very-hot": "#e53935",
  hot: "#fb8c00",
  warm: "#fdd835",
  cool: "#7cb342",
  cold: "#90a4ae",
  dormant: "#546e7a",
  none: "#bdbdbd",
};

export function computeActivityHeat(
  iso: string | null,
  now: number = Date.now()
): ActivityHeat {
  if (!iso) {
    return {
      level: "none",
      color: HEAT_COLORS.none,
      label: "no activity",
      tooltip: "No recorded activity",
    };
  }
  const date = new Date(iso);
  const t = date.getTime();
  if (!Number.isFinite(t)) {
    return {
      level: "none",
      color: HEAT_COLORS.none,
      label: "no activity",
      tooltip: "No recorded activity",
    };
  }
  const diffMs = Math.max(0, now - t);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const tooltip = `Last active ${formatLastActivity(iso)}`;

  let level: ActivityHeatLevel;
  if (diffMs < hour) level = "very-hot";
  else if (diffMs < day) level = "hot";
  else if (diffMs < 3 * day) level = "warm";
  else if (diffMs < 7 * day) level = "cool";
  else if (diffMs < 30 * day) level = "cold";
  else level = "dormant";

  return {
    level,
    color: HEAT_COLORS[level],
    label: level.replace("-", " "),
    tooltip,
  };
}

// Two default-visible sort modes. "activity" is the original alphabetical
// order kept as a toggle-back option so users who preferred the old layout
// aren't stranded — see task #31 acceptance criterion 123.
export type RepoSortMode = "work" | "alphabetical";

export const REPO_SORT_LABEL: Record<RepoSortMode, string> = {
  work: "Most worked",
  alphabetical: "A → Z",
};

// Default sort key: cumulative work per repo (all-time task count, with
// completed count as a tiebreaker so two equally-large repos with different
// throughput still land in a sensible order). Alphabetical secondary key
// keeps the order stable when both totals are zero (fresh repos sink to the
// bottom together).
export function sortRepos(repos: Repo[], mode: RepoSortMode): Repo[] {
  const copy = [...repos];
  if (mode === "alphabetical") {
    return copy.sort((a, b) =>
      repoDisplayName(a).localeCompare(repoDisplayName(b))
    );
  }
  return copy.sort((a, b) => {
    const totalDiff = (b.task_total ?? 0) - (a.task_total ?? 0);
    if (totalDiff !== 0) return totalDiff;
    const doneDiff = (b.task_done ?? 0) - (a.task_done ?? 0);
    if (doneDiff !== 0) return doneDiff;
    return repoDisplayName(a).localeCompare(repoDisplayName(b));
  });
}

export interface BranchSyncDisplay {
  color: "default" | "success" | "warning" | "error" | "info";
  label: string;
  tooltip: string;
}

// Turn the server's collapsed BranchSyncState + counts into a MUI chip's
// visual props. Includes the branch names in the tooltip so the badge is
// unambiguous even when several repos with different base/parent pairs sit
// side-by-side.
export function branchSyncDisplay(repo: Repo): BranchSyncDisplay {
  const { branch_sync_state, branch_ahead, branch_behind, base_branch, base_branch_parent } = repo;
  const pair = `${base_branch} ↔ ${base_branch_parent}`;
  if (branch_sync_state === "synced") {
    return {
      color: "success",
      label: "in sync",
      tooltip: `${pair}: in sync`,
    };
  }
  if (branch_sync_state === "ahead") {
    return {
      color: "info",
      label: `${base_branch} ↑${branch_ahead ?? 0}`,
      tooltip: `${base_branch} is ${branch_ahead ?? 0} commit${
        (branch_ahead ?? 0) === 1 ? "" : "s"
      } ahead of ${base_branch_parent}`,
    };
  }
  if (branch_sync_state === "behind") {
    return {
      color: "warning",
      label: `${base_branch} ↓${branch_behind ?? 0}`,
      tooltip: `${base_branch} is ${branch_behind ?? 0} commit${
        (branch_behind ?? 0) === 1 ? "" : "s"
      } behind ${base_branch_parent}`,
    };
  }
  if (branch_sync_state === "diverged") {
    return {
      color: "error",
      label: `diverged ↑${branch_ahead ?? 0} ↓${branch_behind ?? 0}`,
      tooltip: `${pair}: ${branch_ahead ?? 0} ahead / ${branch_behind ?? 0} behind`,
    };
  }
  return {
    color: "default",
    label: "unknown",
    tooltip: `Branch sync unknown — refresh or wait for the next check (${pair})`,
  };
}

// Type re-export for direct import from the display module — callers that
// only need the display helpers shouldn't have to reach into api/types.
export type { BranchSyncState };
