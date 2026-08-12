// Branch-sync cache: verifies snapshots are cached per repo, computed via
// git.getBranchAheadBehind, collapsed into the four sync states the GUI badge
// consumes, and degraded to 'unknown' on missing clones / git failures.

jest.mock("../src/services/git", () => ({
  __esModule: true,
  getBranchAheadBehind: jest.fn(),
}));

jest.mock("../src/db/repos", () => ({
  __esModule: true,
  getAllRepos: jest.fn(),
}));

import { Repo } from "../src/interfaces";
import { getBranchAheadBehind } from "../src/services/git";
import { getAllRepos } from "../src/db/repos";
import {
  _resetBranchSyncCacheForTest,
  forgetBranchSyncSnapshot,
  getBranchSyncSnapshot,
  refreshAllBranchSync,
  refreshBranchSyncForRepo,
} from "../src/services/branchSyncCache";

function makeRepo(partial: Partial<Repo> & { id: number }): Repo {
  return {
    owner: "octo",
    repo_name: "hello",
    active: true,
    base_branch: "grunt",
    base_branch_parent: "main",
    require_pr: false,
    git_pat: null,
    git_provider: "github",
    ado_project: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_repo",
    max_retries: 3,
    on_parent_child_fail: "mark_partial",
    ordering_mode: "sequential",
    clone_status: "ready",
    clone_error: null,
    created_at: new Date(),
    ...partial,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetBranchSyncCacheForTest();
});

describe("branchSyncCache", () => {
  it("returns the 'unknown' sentinel when no snapshot has been computed yet", () => {
    const snap = getBranchSyncSnapshot(42);
    expect(snap).toEqual({
      branch_ahead: null,
      branch_behind: null,
      branch_sync_state: "unknown",
      branch_sync_checked_at: null,
    });
  });

  it("computes and caches a 'synced' snapshot when ahead=0 and behind=0", async () => {
    (getBranchAheadBehind as jest.Mock).mockResolvedValue({ ahead: 0, behind: 0 });
    const repo = makeRepo({ id: 1 });

    const snap = await refreshBranchSyncForRepo("/repos", repo);

    expect(snap.branch_ahead).toBe(0);
    expect(snap.branch_behind).toBe(0);
    expect(snap.branch_sync_state).toBe("synced");
    expect(snap.branch_sync_checked_at).not.toBeNull();
    // Subsequent reads return the cached value (no recomputation).
    expect(getBranchSyncSnapshot(1)).toEqual(snap);
  });

  it("collapses ahead-only counts into state='ahead'", async () => {
    (getBranchAheadBehind as jest.Mock).mockResolvedValue({ ahead: 5, behind: 0 });
    const snap = await refreshBranchSyncForRepo("/repos", makeRepo({ id: 2 }));
    expect(snap.branch_sync_state).toBe("ahead");
    expect(snap.branch_ahead).toBe(5);
    expect(snap.branch_behind).toBe(0);
  });

  it("collapses behind-only counts into state='behind'", async () => {
    (getBranchAheadBehind as jest.Mock).mockResolvedValue({ ahead: 0, behind: 3 });
    const snap = await refreshBranchSyncForRepo("/repos", makeRepo({ id: 3 }));
    expect(snap.branch_sync_state).toBe("behind");
  });

  it("collapses non-zero on both sides into state='diverged'", async () => {
    (getBranchAheadBehind as jest.Mock).mockResolvedValue({ ahead: 4, behind: 2 });
    const snap = await refreshBranchSyncForRepo("/repos", makeRepo({ id: 4 }));
    expect(snap.branch_sync_state).toBe("diverged");
    expect(snap.branch_ahead).toBe(4);
    expect(snap.branch_behind).toBe(2);
  });

  it("degrades to state='unknown' when git.getBranchAheadBehind returns null (missing clone)", async () => {
    (getBranchAheadBehind as jest.Mock).mockResolvedValue(null);
    const snap = await refreshBranchSyncForRepo("/repos", makeRepo({ id: 5 }));
    expect(snap.branch_sync_state).toBe("unknown");
    expect(snap.branch_ahead).toBeNull();
    expect(snap.branch_behind).toBeNull();
    // checked_at is still set — we ran the check, it just couldn't produce a
    // result. The UI uses this to say "checked N minutes ago, unknown".
    expect(snap.branch_sync_checked_at).not.toBeNull();
  });

  it("degrades to state='unknown' when git.getBranchAheadBehind throws", async () => {
    (getBranchAheadBehind as jest.Mock).mockRejectedValue(new Error("boom"));
    const snap = await refreshBranchSyncForRepo("/repos", makeRepo({ id: 6 }));
    expect(snap.branch_sync_state).toBe("unknown");
  });

  it("skips git ops for local-folder repos and stores an 'unknown' snapshot", async () => {
    const snap = await refreshBranchSyncForRepo(
      "/repos",
      makeRepo({ id: 7, is_local_folder: true, local_path: "/tmp/x" })
    );
    expect(getBranchAheadBehind).not.toHaveBeenCalled();
    expect(snap.branch_sync_state).toBe("unknown");
  });

  it("skips git ops when clone_status is not 'ready' (nothing to compare)", async () => {
    const snap = await refreshBranchSyncForRepo(
      "/repos",
      makeRepo({ id: 8, clone_status: "error" })
    );
    expect(getBranchAheadBehind).not.toHaveBeenCalled();
    expect(snap.branch_sync_state).toBe("unknown");
  });

  it("skips git ops when owner or repo_name is missing", async () => {
    const snap = await refreshBranchSyncForRepo(
      "/repos",
      makeRepo({ id: 9, owner: null, repo_name: null })
    );
    expect(getBranchAheadBehind).not.toHaveBeenCalled();
    expect(snap.branch_sync_state).toBe("unknown");
  });

  it("forgetBranchSyncSnapshot drops the cached entry so a deleted repo doesn't leak", async () => {
    (getBranchAheadBehind as jest.Mock).mockResolvedValue({ ahead: 1, behind: 0 });
    await refreshBranchSyncForRepo("/repos", makeRepo({ id: 10 }));
    expect(getBranchSyncSnapshot(10).branch_sync_state).toBe("ahead");
    forgetBranchSyncSnapshot(10);
    expect(getBranchSyncSnapshot(10).branch_sync_state).toBe("unknown");
  });

  it("refreshAllBranchSync computes a snapshot for each repo returned by getAllRepos", async () => {
    (getAllRepos as jest.Mock).mockResolvedValue([
      makeRepo({ id: 100 }),
      makeRepo({ id: 101 }),
      makeRepo({ id: 102, is_local_folder: true }),
    ]);
    (getBranchAheadBehind as jest.Mock).mockResolvedValue({ ahead: 0, behind: 0 });

    await refreshAllBranchSync({} as never, "/repos");

    expect(getBranchSyncSnapshot(100).branch_sync_state).toBe("synced");
    expect(getBranchSyncSnapshot(101).branch_sync_state).toBe("synced");
    // Local-folder repo bypasses the git call and lands on 'unknown'.
    expect(getBranchSyncSnapshot(102).branch_sync_state).toBe("unknown");
  });
});
