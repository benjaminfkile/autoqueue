import { describe, it, expect } from "vitest";
import {
  countTasksByStatus,
  formatLastActivity,
  lastActivityIso,
  repoDisplayName,
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
    github_token: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_subtree",
    max_retries: 0,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
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
