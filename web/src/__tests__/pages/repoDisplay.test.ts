import { describe, it, expect } from "vitest";
import {
  branchSyncDisplay,
  computeActivityHeat,
  countTasksByStatus,
  formatLastActivity,
  lastActivityIso,
  repoDisplayName,
  sortRepos,
} from "../../pages/repos/repoDisplay";
import type { Repo, TaskSummary } from "../../api/types";

function makeRepo(partial: Partial<Repo>): Repo {
  return {
    id: 1,
    owner: null,
    repo_name: null,
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    git_pat: null, git_provider: "github" as const, ado_project: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_subtree",
    max_retries: 0,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
    clone_status: "ready",
    clone_error: null,
    task_total: 0,
    task_done: 0,
    last_activity_at: null,
    branch_ahead: null,
    branch_behind: null,
    branch_sync_state: "unknown",
    branch_sync_checked_at: null,
    created_at: new Date(0).toISOString(),
    ...partial,
  };
}

function makeTask(partial: Partial<TaskSummary>): TaskSummary {
  return {
    id: 1,
    repo_id: 1,
    parent_id: null,
    title: "t",
    status: "pending",
    order_position: 0,
    children_count: 0,
    requires_approval: false,
    created_at: new Date(0).toISOString(),
    ...partial,
  };
}

describe("repoDisplayName", () => {
  it("uses owner/repo for github repos", () => {
    expect(
      repoDisplayName(makeRepo({ owner: "alice", repo_name: "tools" }))
    ).toBe("alice/tools");
  });

  it("prefers local_path for local folder repos", () => {
    expect(
      repoDisplayName(
        makeRepo({
          is_local_folder: true,
          local_path: "/tmp/projects/a",
          owner: "ignored",
          repo_name: "ignored",
        })
      )
    ).toBe("/tmp/projects/a");
  });

  it("falls back to repo id when nothing else is set", () => {
    expect(repoDisplayName(makeRepo({ id: 9 }))).toBe("Repo #9");
  });
});

describe("countTasksByStatus", () => {
  it("groups tasks by status", () => {
    const counts = countTasksByStatus([
      makeTask({ id: 1, status: "pending" }),
      makeTask({ id: 2, status: "active" }),
      makeTask({ id: 3, status: "active" }),
      makeTask({ id: 4, status: "done" }),
      makeTask({ id: 5, status: "failed" }),
      makeTask({ id: 6, status: "failed" }),
    ]);
    expect(counts).toEqual({
      pending: 1,
      active: 2,
      done: 1,
      failed: 2,
      interrupted: 0,
    });
  });

  it("returns zeros for an empty list", () => {
    expect(countTasksByStatus([])).toEqual({
      pending: 0,
      active: 0,
      done: 0,
      failed: 0,
      interrupted: 0,
    });
  });
});

describe("lastActivityIso", () => {
  it("returns the most recent created_at", () => {
    const later = new Date("2026-04-25T12:00:00Z").toISOString();
    const earlier = new Date("2025-01-01T00:00:00Z").toISOString();
    expect(
      lastActivityIso([
        makeTask({ id: 1, created_at: earlier }),
        makeTask({ id: 2, created_at: later }),
      ])
    ).toBe(later);
  });

  it("returns null for an empty list", () => {
    expect(lastActivityIso([])).toBeNull();
  });
});

describe("formatLastActivity", () => {
  it("returns em dash for null", () => {
    expect(formatLastActivity(null)).toBe("—");
  });
});

describe("computeActivityHeat", () => {
  const now = new Date("2026-08-12T12:00:00Z").getTime();

  it("returns 'none' when there is no activity", () => {
    const heat = computeActivityHeat(null, now);
    expect(heat.level).toBe("none");
    expect(heat.tooltip).toMatch(/no.*activity/i);
  });

  it("returns 'very-hot' for activity in the last hour", () => {
    const iso = new Date(now - 30 * 60_000).toISOString();
    expect(computeActivityHeat(iso, now).level).toBe("very-hot");
  });

  it("returns 'hot' between 1h and 1d", () => {
    const iso = new Date(now - 6 * 60 * 60_000).toISOString();
    expect(computeActivityHeat(iso, now).level).toBe("hot");
  });

  it("returns 'warm' between 1d and 3d", () => {
    const iso = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
    expect(computeActivityHeat(iso, now).level).toBe("warm");
  });

  it("returns 'cool' between 3d and 7d", () => {
    const iso = new Date(now - 5 * 24 * 60 * 60_000).toISOString();
    expect(computeActivityHeat(iso, now).level).toBe("cool");
  });

  it("returns 'cold' between 7d and 30d — the boundary Ben cares about for dormancy", () => {
    const iso = new Date(now - 14 * 24 * 60 * 60_000).toISOString();
    expect(computeActivityHeat(iso, now).level).toBe("cold");
  });

  it("returns 'dormant' past 30d — the visually distinct sink for projects Ben isn't touching", () => {
    const iso = new Date(now - 90 * 24 * 60 * 60_000).toISOString();
    expect(computeActivityHeat(iso, now).level).toBe("dormant");
  });
});

describe("sortRepos", () => {
  it("sorts by task_total descending by default (most-worked at top)", () => {
    const a = makeRepo({ id: 1, owner: "a", repo_name: "a", task_total: 2 });
    const b = makeRepo({ id: 2, owner: "b", repo_name: "b", task_total: 10 });
    const c = makeRepo({ id: 3, owner: "c", repo_name: "c", task_total: 5 });
    const sorted = sortRepos([a, b, c], "work");
    expect(sorted.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("tiebreaks by task_done then name so dormant repos sink together in a stable order", () => {
    const a = makeRepo({
      id: 1,
      owner: "b",
      repo_name: "z",
      task_total: 0,
      task_done: 0,
    });
    const b = makeRepo({
      id: 2,
      owner: "a",
      repo_name: "y",
      task_total: 0,
      task_done: 0,
    });
    const sorted = sortRepos([a, b], "work");
    expect(sorted.map((r) => r.id)).toEqual([2, 1]);
  });

  it("supports the alphabetical toggle-back mode so users who preferred the old order aren't stranded", () => {
    const a = makeRepo({ id: 1, owner: "b", repo_name: "b", task_total: 100 });
    const b = makeRepo({ id: 2, owner: "a", repo_name: "a", task_total: 1 });
    const sorted = sortRepos([a, b], "alphabetical");
    expect(sorted.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("branchSyncDisplay", () => {
  it("renders a green 'in sync' badge when synced", () => {
    const d = branchSyncDisplay(
      makeRepo({
        branch_sync_state: "synced",
        branch_ahead: 0,
        branch_behind: 0,
      })
    );
    expect(d.color).toBe("success");
    expect(d.label).toMatch(/in sync/i);
  });

  it("shows ahead count when ahead only", () => {
    const d = branchSyncDisplay(
      makeRepo({
        base_branch: "grunt",
        base_branch_parent: "main",
        branch_sync_state: "ahead",
        branch_ahead: 2,
        branch_behind: 0,
      })
    );
    expect(d.label).toContain("grunt");
    expect(d.label).toContain("↑2");
  });

  it("shows behind count when behind only", () => {
    const d = branchSyncDisplay(
      makeRepo({
        base_branch: "grunt",
        base_branch_parent: "main",
        branch_sync_state: "behind",
        branch_ahead: 0,
        branch_behind: 3,
      })
    );
    expect(d.color).toBe("warning");
    expect(d.label).toContain("↓3");
  });

  it("labels diverged with both counts and the error color so it's visually loud", () => {
    const d = branchSyncDisplay(
      makeRepo({
        branch_sync_state: "diverged",
        branch_ahead: 4,
        branch_behind: 2,
      })
    );
    expect(d.color).toBe("error");
    expect(d.label).toMatch(/↑4/);
    expect(d.label).toMatch(/↓2/);
  });

  it("falls back to 'unknown' for cache misses / missing clones so the UI doesn't fake 'synced'", () => {
    const d = branchSyncDisplay(
      makeRepo({
        branch_sync_state: "unknown",
        branch_ahead: null,
        branch_behind: null,
      })
    );
    expect(d.color).toBe("default");
    expect(d.label).toBe("unknown");
  });
});
