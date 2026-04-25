import type { Repo, TaskStatus, TaskSummary } from "../../api/types";

export const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "active",
  "done",
  "failed",
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
  return { pending: 0, active: 0, done: 0, failed: 0 };
}

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
