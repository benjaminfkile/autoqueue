type GitMock = {
  dir: string;
  branchLocal: jest.Mock;
  deleteLocalBranch: jest.Mock;
  checkout: jest.Mock;
};

const mockState: {
  instances: GitMock[];
  nextBranches: string[];
} = {
  instances: [],
  nextBranches: [],
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
      };
      mockState.instances.push(git);
      return git;
    },
  };
});

import { createTaskBranch } from "../src/services/git";
import * as path from "path";

beforeEach(() => {
  mockState.instances = [];
  mockState.nextBranches = [];
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
