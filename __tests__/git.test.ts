type GitMock = {
  dir: string;
  branchLocal: jest.Mock;
  deleteLocalBranch: jest.Mock;
  checkout: jest.Mock;
  listRemote: jest.Mock;
  fetch: jest.Mock;
  pull: jest.Mock;
  push: jest.Mock;
  add: jest.Mock;
  commit: jest.Mock;
  remote: jest.Mock;
  clone: jest.Mock;
  merge: jest.Mock;
  status: jest.Mock;
};

const mockState: {
  instances: GitMock[];
  nextBranches: string[];
  nextRemoteHeads: string;
  nextPushRejection: Error | null;
  nextStatus: {
    modified: string[];
    created: string[];
    not_added: string[];
    deleted: string[];
    renamed: string[];
    staged: string[];
  };
} = {
  instances: [],
  nextBranches: [],
  nextRemoteHeads: "",
  nextPushRejection: null,
  nextStatus: {
    modified: [],
    created: [],
    not_added: [],
    deleted: [],
    renamed: [],
    staged: [],
  },
};

jest.mock("simple-git", () => {
  return {
    __esModule: true,
    default: (dir: string) => {
      const git: GitMock = {
        dir,
        branchLocal: jest
          .fn()
          .mockImplementation(async () => ({ all: mockState.nextBranches })),
        deleteLocalBranch: jest.fn().mockResolvedValue(undefined),
        checkout: jest.fn().mockResolvedValue(undefined),
        listRemote: jest
          .fn()
          .mockImplementation(async () => mockState.nextRemoteHeads),
        fetch: jest.fn().mockResolvedValue(undefined),
        pull: jest.fn().mockResolvedValue(undefined),
        push: jest.fn().mockImplementation(async (args?: string[]) => {
          // The rejection latch only fires on a "delete this remote branch"
          // push so tests targeting cleanup don't accidentally fail an
          // earlier commit/merge push that uses different (or no) args.
          const isRemoteDelete =
            Array.isArray(args) && args[0] === "origin" && args[1] === "--delete";
          if (mockState.nextPushRejection && isRemoteDelete) {
            const err = mockState.nextPushRejection;
            mockState.nextPushRejection = null;
            throw err;
          }
        }),
        add: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        remote: jest.fn().mockResolvedValue(undefined),
        clone: jest.fn().mockResolvedValue(undefined),
        merge: jest.fn().mockResolvedValue(undefined),
        status: jest
          .fn()
          .mockImplementation(async () => mockState.nextStatus),
      };
      mockState.instances.push(git);
      return git;
    },
  };
});

const fsMockState = {
  existing: new Set<string>(),
  mkdirCalls: [] as string[],
};

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn((p: string) => fsMockState.existing.has(p)),
    mkdirSync: jest.fn((p: string) => {
      fsMockState.mkdirCalls.push(p);
    }),
  };
});

import {
  checkoutBaseBranch,
  cloneOrPull,
  commitAndPush,
  commitAndPushTask,
  createIssueBranch,
  createTaskBranch,
  hasUncommittedChanges,
  mergeIntoBase,
  mergeTaskIntoBase,
} from "../src/services/git";
import * as path from "path";

beforeEach(() => {
  mockState.instances = [];
  mockState.nextBranches = [];
  mockState.nextRemoteHeads = "";
  mockState.nextPushRejection = null;
  mockState.nextStatus = {
    modified: [],
    created: [],
    not_added: [],
    deleted: [],
    renamed: [],
    staged: [],
  };
  fsMockState.existing = new Set();
  fsMockState.mkdirCalls = [];
});

describe("createTaskBranch", () => {
  it("returns the deterministic branch name `grunt-task-{taskId}`", async () => {
    const branch = await createTaskBranch(
      "/repos",
      "ghp_token",
      "octocat",
      "hello",
      "main",
      42
    );
    expect(branch).toBe("grunt-task-42");
  });

  it("opens simple-git against the resolved repo path", async () => {
    await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 7);
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].dir).toBe(
      path.join("/repos", "octocat", "hello")
    );
  });

  it("creates the branch from baseBranch via `checkout -b`", async () => {
    await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 7);

    const git = mockState.instances[0];
    expect(git.checkout).toHaveBeenCalledWith(["-b", "grunt-task-7", "main"]);
  });

  it("deletes the existing local branch before recreating it", async () => {
    mockState.nextBranches = ["grunt-task-99", "some-other-branch"];

    await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 99);

    const git = mockState.instances[0];
    expect(git.deleteLocalBranch).toHaveBeenCalledWith("grunt-task-99", true);
    expect(git.checkout).toHaveBeenCalledWith([
      "-b",
      "grunt-task-99",
      "main",
    ]);
  });

  it("does not delete the local branch when it does not already exist", async () => {
    mockState.nextBranches = ["main", "develop"];

    await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 1);

    const git = mockState.instances[0];
    expect(git.deleteLocalBranch).not.toHaveBeenCalled();
    expect(git.checkout).toHaveBeenCalledWith(["-b", "grunt-task-1", "main"]);
  });

  it("returns the same branch name across repeated calls for the same taskId", async () => {
    const a = await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 5);
    const b = await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 5);
    expect(a).toBe("grunt-task-5");
    expect(b).toBe("grunt-task-5");
    expect(a).toBe(b);
  });

  it("attempts a best-effort remote delete with PAT-authenticated origin so reruns aren't blocked by stale remote state", async () => {
    await createTaskBranch("/repos", "ghp_token", "octocat", "hello", "main", 7);

    const git = mockState.instances[0];
    expect(git.remote).toHaveBeenCalledWith([
      "set-url",
      "origin",
      "https://ghp_token@github.com/octocat/hello.git",
    ]);
    expect(git.push).toHaveBeenCalledWith([
      "origin",
      "--delete",
      "grunt-task-7",
    ]);
  });

  it("swallows a remote-delete failure so a first run (or already-deleted branch) still proceeds", async () => {
    // The most common cause in practice is the remote branch simply not
    // existing yet (first attempt of a task). createTaskBranch must
    // tolerate the push rejection and still create the local branch.
    mockState.nextPushRejection = new Error("remote ref does not exist");

    const branch = await createTaskBranch(
      "/repos",
      "ghp_token",
      "octocat",
      "hello",
      "main",
      8
    );

    expect(branch).toBe("grunt-task-8");
    const git = mockState.instances[0];
    // checkout must still happen even though the remote delete blew up
    expect(git.checkout).toHaveBeenCalledWith(["-b", "grunt-task-8", "main"]);
  });
});

describe("checkoutBaseBranch", () => {
  it("when baseBranch already exists locally, just checks out and pulls (existing flow unchanged)", async () => {
    mockState.nextBranches = ["main", "develop"];

    await checkoutBaseBranch("/repos", "octocat", "hello", "develop", "main");

    const git = mockState.instances[0];
    expect(git.listRemote).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(git.checkout).toHaveBeenCalledTimes(1);
    expect(git.checkout).toHaveBeenCalledWith("develop");
    expect(git.pull).toHaveBeenCalledTimes(1);
  });

  it("opens simple-git against the resolved repo path", async () => {
    mockState.nextBranches = ["develop"];

    await checkoutBaseBranch("/repos", "octocat", "hello", "develop", "main");

    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].dir).toBe(
      path.join("/repos", "octocat", "hello")
    );
  });

  it("when baseBranch is missing locally but exists on remote, fetches and creates a tracking branch", async () => {
    mockState.nextBranches = ["main"];
    mockState.nextRemoteHeads =
      "abc123\trefs/heads/develop\n";

    await checkoutBaseBranch("/repos", "octocat", "hello", "develop", "main");

    const git = mockState.instances[0];
    expect(git.listRemote).toHaveBeenCalledWith([
      "--heads",
      "origin",
      "develop",
    ]);
    expect(git.fetch).toHaveBeenCalledWith(["origin", "develop"]);
    expect(git.checkout).toHaveBeenCalledWith([
      "-b",
      "develop",
      "origin/develop",
    ]);
    expect(git.push).not.toHaveBeenCalled();
  });

  it("when baseBranch is missing both locally and on remote, creates it from baseBranchParent and pushes with --set-upstream", async () => {
    mockState.nextBranches = ["main"];
    mockState.nextRemoteHeads = "";

    await checkoutBaseBranch("/repos", "octocat", "hello", "develop", "main");

    const git = mockState.instances[0];

    expect(git.listRemote).toHaveBeenCalledWith([
      "--heads",
      "origin",
      "develop",
    ]);
    expect(git.fetch).not.toHaveBeenCalled();

    const checkoutCalls = git.checkout.mock.calls;
    // 1) checkout parent  2) checkout -b develop  3) final checkout develop
    expect(checkoutCalls[0]).toEqual(["main"]);
    expect(checkoutCalls[1]).toEqual([["-b", "develop"]]);
    expect(checkoutCalls[2]).toEqual(["develop"]);

    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "develop",
    ]);

    // Pull is called once on the parent before creating the branch, and once
    // again at the end on the now-current base branch.
    expect(git.pull).toHaveBeenCalledTimes(2);
  });

  it("treats whitespace-only ls-remote output as 'branch does not exist on remote'", async () => {
    mockState.nextBranches = ["main"];
    mockState.nextRemoteHeads = "   \n";

    await checkoutBaseBranch("/repos", "octocat", "hello", "develop", "main");

    const git = mockState.instances[0];
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "develop",
    ]);
  });

  it("uses the supplied baseBranchParent (not hard-coded 'main') when creating the new base branch", async () => {
    mockState.nextBranches = ["release"];
    mockState.nextRemoteHeads = "";

    await checkoutBaseBranch(
      "/repos",
      "octocat",
      "hello",
      "develop",
      "release"
    );

    const git = mockState.instances[0];
    expect(git.checkout.mock.calls[0]).toEqual(["release"]);
    expect(git.checkout.mock.calls[1]).toEqual([["-b", "develop"]]);
  });
});

describe("commitAndPushTask", () => {
  it("pushes with --set-upstream and does not pass --force", async () => {
    await commitAndPushTask(
      "/repos",
      "pat-token",
      "octocat",
      "hello",
      "grunt-task-42",
      "task: 42"
    );

    const git = mockState.instances[0];
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "grunt-task-42",
    ]);

    const pushArgs = git.push.mock.calls[0][0] as string[];
    expect(pushArgs).not.toContain("--force");
    expect(pushArgs).not.toContain("-f");
  });

  it("stages all changes, commits with the supplied message, and sets the authenticated remote URL", async () => {
    await commitAndPushTask(
      "/repos",
      "pat-token",
      "octocat",
      "hello",
      "grunt-task-7",
      "task: 7"
    );

    const git = mockState.instances[0];
    expect(git.add).toHaveBeenCalledWith("-A");
    expect(git.commit).toHaveBeenCalledWith("task: 7");
    expect(git.remote).toHaveBeenCalledWith([
      "set-url",
      "origin",
      "https://pat-token@github.com/octocat/hello.git",
    ]);
  });

  it("does not pass --force on a retry of the same task (clean push after createTaskBranch recreated the branch)", async () => {
    // Simulate a retry: createTaskBranch is called, sees an existing local
    // branch, deletes it, and recreates it from baseBranch. Then we commit
    // and push.
    mockState.nextBranches = ["grunt-task-5"];

    const branch = await createTaskBranch(
      "/repos",
      "pat-token",
      "octocat",
      "hello",
      "main",
      5
    );

    await commitAndPushTask(
      "/repos",
      "pat-token",
      "octocat",
      "hello",
      branch,
      "task: 5 (retry)"
    );

    // createTaskBranch + commitAndPushTask each open a new simple-git instance.
    expect(mockState.instances).toHaveLength(2);

    const createBranchGit = mockState.instances[0];
    expect(createBranchGit.deleteLocalBranch).toHaveBeenCalledWith(
      "grunt-task-5",
      true
    );
    expect(createBranchGit.checkout).toHaveBeenCalledWith([
      "-b",
      "grunt-task-5",
      "main",
    ]);

    const pushGit = mockState.instances[1];
    expect(pushGit.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "grunt-task-5",
    ]);
    const pushArgs = pushGit.push.mock.calls[0][0] as string[];
    expect(pushArgs).not.toContain("--force");
    expect(pushArgs).not.toContain("-f");
  });
});

// ---------------------------------------------------------------------------
// Coverage gate — exercise the remaining git.ts functions so the Phase 1
// coverage threshold (≥80% on src/services/git.ts) is met.
// ---------------------------------------------------------------------------
describe("cloneOrPull", () => {
  it("clones when the repo directory does not exist, after creating the parent dir", async () => {
    // Parent dir doesn't exist → mkdirSync called → top-level simpleGit().clone(remote, dir)
    await cloneOrPull("/repos", "pat-token", "octocat", "hello");

    expect(fsMockState.mkdirCalls).toEqual([path.join("/repos", "octocat")]);
    // The first instance is the top-level simpleGit() with no dir.
    const cloneGit = mockState.instances[0];
    expect(cloneGit.clone).toHaveBeenCalledWith(
      "https://pat-token@github.com/octocat/hello.git",
      path.join("/repos", "octocat", "hello")
    );
  });

  it("fetches when the repo directory already exists", async () => {
    const dir = path.join("/repos", "octocat", "hello");
    fsMockState.existing.add(dir);

    await cloneOrPull("/repos", "pat-token", "octocat", "hello");

    const fetchGit = mockState.instances[0];
    expect(fetchGit.dir).toBe(dir);
    expect(fetchGit.fetch).toHaveBeenCalled();
    expect(fetchGit.clone).not.toHaveBeenCalled();
  });
});

describe("createIssueBranch", () => {
  it("creates issue/{n} from baseBranch and deletes any pre-existing local branch first", async () => {
    mockState.nextBranches = ["issue/15", "main"];

    await createIssueBranch("/repos", "octocat", "hello", "main", 15);

    const git = mockState.instances[0];
    expect(git.deleteLocalBranch).toHaveBeenCalledWith("issue/15", true);
    expect(git.checkout).toHaveBeenCalledWith(["-b", "issue/15", "main"]);
  });

  it("does not delete when no local branch exists for the issue", async () => {
    mockState.nextBranches = ["main"];

    await createIssueBranch("/repos", "octocat", "hello", "main", 99);

    const git = mockState.instances[0];
    expect(git.deleteLocalBranch).not.toHaveBeenCalled();
    expect(git.checkout).toHaveBeenCalledWith(["-b", "issue/99", "main"]);
  });
});

describe("commitAndPush (legacy, issue-based)", () => {
  it("stages, commits, sets remote URL, and pushes the issue branch with --set-upstream", async () => {
    await commitAndPush(
      "/repos",
      "pat-token",
      "octocat",
      "hello",
      42,
      "fix: 42"
    );

    const git = mockState.instances[0];
    expect(git.add).toHaveBeenCalledWith("-A");
    expect(git.commit).toHaveBeenCalledWith("fix: 42");
    expect(git.remote).toHaveBeenCalledWith([
      "set-url",
      "origin",
      "https://pat-token@github.com/octocat/hello.git",
    ]);
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "issue/42",
    ]);
  });
});

describe("mergeIntoBase (legacy, issue-based)", () => {
  it("checks out the base, merges --no-ff, pushes, and deletes the issue branch", async () => {
    await mergeIntoBase("/repos", "pat-token", "octocat", "hello", "main", 7);

    const git = mockState.instances[0];
    expect(git.checkout).toHaveBeenCalledWith("main");
    expect(git.merge).toHaveBeenCalledWith(["--no-ff", "issue/7"]);
    expect(git.remote).toHaveBeenCalledWith([
      "set-url",
      "origin",
      "https://pat-token@github.com/octocat/hello.git",
    ]);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.deleteLocalBranch).toHaveBeenCalledWith("issue/7", true);
  });
});

describe("mergeTaskIntoBase", () => {
  it("checks out base, merges the task branch with --no-ff, pushes the merge, and deletes the task branch locally + remotely", async () => {
    await mergeTaskIntoBase(
      "/repos",
      "pat-token",
      "octocat",
      "hello",
      "main",
      "grunt-task-42"
    );

    const git = mockState.instances[0];
    expect(git.checkout).toHaveBeenCalledWith("main");
    expect(git.merge).toHaveBeenCalledWith(["--no-ff", "grunt-task-42"]);
    expect(git.remote).toHaveBeenCalledWith([
      "set-url",
      "origin",
      "https://pat-token@github.com/octocat/hello.git",
    ]);
    // Two pushes: the merge to base, then the branch deletion. Asserting
    // both keeps the order intent (merge first, cleanup second) explicit.
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(git.push).toHaveBeenNthCalledWith(1);
    expect(git.push).toHaveBeenNthCalledWith(2, [
      "origin",
      "--delete",
      "grunt-task-42",
    ]);
    expect(git.deleteLocalBranch).toHaveBeenCalledWith("grunt-task-42", true);
  });

  it("swallows a remote-delete failure so a successful merge isn't reported as a task failure", async () => {
    // The remote branch may already be gone (cleaned up by another worker,
    // never pushed, etc.). The merge has happened and base is up-to-date —
    // we must not blow up the run on cleanup.
    mockState.nextPushRejection = new Error("remote ref does not exist");

    await expect(
      mergeTaskIntoBase(
        "/repos",
        "pat-token",
        "octocat",
        "hello",
        "main",
        "grunt-task-7"
      )
    ).resolves.toBeUndefined();

    const git = mockState.instances[0];
    // The local cleanup still happened.
    expect(git.deleteLocalBranch).toHaveBeenCalledWith("grunt-task-7", true);
  });
});

describe("hasUncommittedChanges", () => {
  it("returns false when the status is fully clean", async () => {
    const result = await hasUncommittedChanges("/repos", "octocat", "hello");
    expect(result).toBe(false);
  });

  it("returns true when any of the change buckets is non-empty", async () => {
    const buckets: Array<keyof typeof mockState.nextStatus> = [
      "modified",
      "created",
      "not_added",
      "deleted",
      "renamed",
      "staged",
    ];
    for (const bucket of buckets) {
      mockState.instances = [];
      mockState.nextStatus = {
        modified: [],
        created: [],
        not_added: [],
        deleted: [],
        renamed: [],
        staged: [],
      };
      mockState.nextStatus[bucket] = ["some-file.ts"];

      // eslint-disable-next-line no-await-in-loop
      const result = await hasUncommittedChanges("/repos", "octocat", "hello");
      expect(result).toBe(true);
    }
  });
});
