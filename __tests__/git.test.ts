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
};

const mockState: {
  instances: GitMock[];
  nextBranches: string[];
  nextRemoteHeads: string;
} = {
  instances: [],
  nextBranches: [],
  nextRemoteHeads: "",
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
        push: jest.fn().mockResolvedValue(undefined),
        add: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        remote: jest.fn().mockResolvedValue(undefined),
      };
      mockState.instances.push(git);
      return git;
    },
  };
});

import {
  checkoutBaseBranch,
  commitAndPushTask,
  createTaskBranch,
} from "../src/services/git";
import * as path from "path";

beforeEach(() => {
  mockState.instances = [];
  mockState.nextBranches = [];
  mockState.nextRemoteHeads = "";
});

describe("createTaskBranch", () => {
  it("returns the deterministic branch name `grunt/task-{taskId}`", async () => {
    const branch = await createTaskBranch(
      "/repos",
      "octocat",
      "hello",
      "main",
      42
    );
    expect(branch).toBe("grunt/task-42");
  });

  it("opens simple-git against the resolved repo path", async () => {
    await createTaskBranch("/repos", "octocat", "hello", "main", 7);
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].dir).toBe(
      path.join("/repos", "octocat", "hello")
    );
  });

  it("creates the branch from baseBranch via `checkout -b`", async () => {
    await createTaskBranch("/repos", "octocat", "hello", "main", 7);

    const git = mockState.instances[0];
    expect(git.checkout).toHaveBeenCalledWith(["-b", "grunt/task-7", "main"]);
  });

  it("deletes the existing local branch before recreating it", async () => {
    mockState.nextBranches = ["grunt/task-99", "some-other-branch"];

    await createTaskBranch("/repos", "octocat", "hello", "main", 99);

    const git = mockState.instances[0];
    expect(git.deleteLocalBranch).toHaveBeenCalledWith("grunt/task-99", true);
    expect(git.checkout).toHaveBeenCalledWith([
      "-b",
      "grunt/task-99",
      "main",
    ]);
  });

  it("does not delete the branch when it does not already exist", async () => {
    mockState.nextBranches = ["main", "develop"];

    await createTaskBranch("/repos", "octocat", "hello", "main", 1);

    const git = mockState.instances[0];
    expect(git.deleteLocalBranch).not.toHaveBeenCalled();
    expect(git.checkout).toHaveBeenCalledWith(["-b", "grunt/task-1", "main"]);
  });

  it("returns the same branch name across repeated calls for the same taskId", async () => {
    const a = await createTaskBranch("/repos", "octocat", "hello", "main", 5);
    const b = await createTaskBranch("/repos", "octocat", "hello", "main", 5);
    expect(a).toBe("grunt/task-5");
    expect(b).toBe("grunt/task-5");
    expect(a).toBe(b);
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
      "grunt/task-42",
      "task: 42"
    );

    const git = mockState.instances[0];
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "grunt/task-42",
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
      "grunt/task-7",
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
    mockState.nextBranches = ["grunt/task-5"];

    const branch = await createTaskBranch(
      "/repos",
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
      "grunt/task-5",
      true
    );
    expect(createBranchGit.checkout).toHaveBeenCalledWith([
      "-b",
      "grunt/task-5",
      "main",
    ]);

    const pushGit = mockState.instances[1];
    expect(pushGit.push).toHaveBeenCalledWith([
      "--set-upstream",
      "origin",
      "grunt/task-5",
    ]);
    const pushArgs = pushGit.push.mock.calls[0][0] as string[];
    expect(pushArgs).not.toContain("--force");
    expect(pushArgs).not.toContain("-f");
  });
});
