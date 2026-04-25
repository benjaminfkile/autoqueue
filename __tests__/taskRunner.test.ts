jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));

jest.mock("../src/db/tasks", () => ({
  getTaskById: jest.fn(),
  getChildTasks: jest.fn(),
  updateTask: jest.fn(),
  getTasksByRepoId: jest.fn(),
  renewTaskLease: jest.fn(),
}));

jest.mock("../src/db/acceptanceCriteria", () => ({
  getCriteriaByTaskId: jest.fn(),
}));

jest.mock("../src/services/git", () => ({
  cloneOrPull: jest.fn(),
  checkoutBaseBranch: jest.fn(),
  createTaskBranch: jest.fn(),
  commitAndPushTask: jest.fn(),
  mergeTaskIntoBase: jest.fn(),
  hasUncommittedChanges: jest.fn(),
}));

jest.mock("../src/services/github", () => ({
  createPullRequest: jest.fn(),
}));

jest.mock("../src/services/claudeRunner", () => ({
  runClaudeOnTask: jest.fn(),
}));

import { getRepoById } from "../src/db/repos";
import {
  getTaskById,
  updateTask,
  getChildTasks,
  getTasksByRepoId,
  renewTaskLease,
} from "../src/db/tasks";
import { getCriteriaByTaskId } from "../src/db/acceptanceCriteria";
import { runClaudeOnTask } from "../src/services/claudeRunner";
import { runTask } from "../src/services/taskRunner";

const getTaskByIdMock = getTaskById as jest.Mock;
const getRepoByIdMock = getRepoById as jest.Mock;
const getCriteriaMock = getCriteriaByTaskId as jest.Mock;
const updateTaskMock = updateTask as jest.Mock;
const runClaudeMock = runClaudeOnTask as jest.Mock;
const getChildTasksMock = getChildTasks as jest.Mock;
const getTasksByRepoIdMock = getTasksByRepoId as jest.Mock;
const renewTaskLeaseMock = renewTaskLease as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getChildTasksMock.mockResolvedValue([]);
  getTasksByRepoIdMock.mockResolvedValue([]);
  renewTaskLeaseMock.mockResolvedValue(undefined);
});

describe("runTask", () => {
  it("does NOT redundantly set the leaf task status to 'active' (the claim already did that)", async () => {
    // Top-level task with no parent so no ancestor walk happens.
    const task = {
      id: 42,
      repo_id: 1,
      parent_id: null,
      title: "leaf",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "host:123",
      leased_until: new Date(),
      created_at: new Date(),
    };
    const repo = {
      id: 1,
      owner: null,
      repo_name: null,
      active: true,
      base_branch: "main",
      base_branch_parent: "main",
      require_pr: false,
      github_token: null,
      is_local_folder: true,
      local_path: "/tmp/repo",
      created_at: new Date(),
    };

    getTaskByIdMock.mockResolvedValue(task);
    getRepoByIdMock.mockResolvedValue(repo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(task);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("success");

    // No call to updateTask on the leaf task with status: 'active'.
    const activeCallsOnLeaf = updateTaskMock.mock.calls.filter(
      ([, id, data]) => id === 42 && data && data.status === "active"
    );
    expect(activeCallsOnLeaf).toHaveLength(0);
  });

  it("still walks up parent chain and activates pending ancestors", async () => {
    const leaf = {
      id: 42,
      repo_id: 1,
      parent_id: 10,
      title: "leaf",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "host:123",
      leased_until: new Date(),
      created_at: new Date(),
    };
    const ancestor = {
      ...leaf,
      id: 10,
      parent_id: null,
      title: "parent",
      status: "pending",
    };
    const repo = {
      id: 1,
      owner: null,
      repo_name: null,
      active: true,
      base_branch: "main",
      base_branch_parent: "main",
      require_pr: false,
      github_token: null,
      is_local_folder: true,
      local_path: "/tmp/repo",
      created_at: new Date(),
    };

    getTaskByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 42) return leaf;
      if (id === 10) return ancestor;
      return undefined;
    });
    getRepoByIdMock.mockResolvedValue(repo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(leaf);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    // The pending ancestor should have been activated.
    const ancestorActivation = updateTaskMock.mock.calls.find(
      ([, id, data]) => id === 10 && data && data.status === "active"
    );
    expect(ancestorActivation).toBeDefined();

    // But the leaf itself was never re-activated.
    const leafActivation = updateTaskMock.mock.calls.find(
      ([, id, data]) => id === 42 && data && data.status === "active"
    );
    expect(leafActivation).toBeUndefined();
  });
});

describe("runTask lease renewal heartbeat", () => {
  const baseTask = {
    id: 42,
    repo_id: 1,
    parent_id: null,
    title: "leaf",
    description: "",
    order_position: 0,
    status: "active",
    retry_count: 0,
    pr_url: null,
    worker_id: "host:123",
    leased_until: new Date(),
    created_at: new Date(),
  };
  const baseRepo = {
    id: 1,
    owner: null,
    repo_name: null,
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    github_token: null,
    is_local_folder: true,
    local_path: "/tmp/repo",
    created_at: new Date(),
  };

  it("renews the lease every 60s while runClaudeOnTask is in flight, with a 30-minute extension", async () => {
    jest.useFakeTimers();
    try {
      getTaskByIdMock.mockResolvedValue(baseTask);
      getRepoByIdMock.mockResolvedValue(baseRepo);
      getCriteriaMock.mockResolvedValue([]);
      updateTaskMock.mockResolvedValue(baseTask);

      // Hold runClaudeOnTask open until we explicitly resolve it. This lets
      // us advance fake timers while the task is "running".
      let resolveClaude!: (v: { success: boolean; output: string }) => void;
      const claudeStarted = new Promise<void>((startResolve) => {
        runClaudeMock.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveClaude = resolve;
              startResolve();
            })
        );
      });

      const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
      const runPromise = runTask({} as any, secrets, 1, 42);

      // Wait for runClaudeOnTask to actually be invoked — this guarantees
      // that all the synchronous-ish setup awaits have settled and the
      // heartbeat interval is armed.
      await claudeStarted;

      expect(renewTaskLeaseMock).not.toHaveBeenCalled();

      // First heartbeat tick.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(renewTaskLeaseMock).toHaveBeenCalledTimes(1);
      // Renewal extends by 30 minutes (1800 seconds).
      expect(renewTaskLeaseMock).toHaveBeenLastCalledWith(
        expect.anything(),
        42,
        1800
      );

      // Two more ticks (3 total).
      await jest.advanceTimersByTimeAsync(60_000);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(renewTaskLeaseMock).toHaveBeenCalledTimes(3);

      // Let the task complete.
      resolveClaude({ success: true, output: "ok" });
      await runPromise;

      const callsAtCompletion = renewTaskLeaseMock.mock.calls.length;

      // After the task returns, the interval must be cleared — no more ticks.
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(renewTaskLeaseMock).toHaveBeenCalledTimes(callsAtCompletion);
    } finally {
      jest.useRealTimers();
    }
  });

  it("clears the renewal interval even when runTask throws (no leaked intervals on failure)", async () => {
    jest.useFakeTimers();
    try {
      getTaskByIdMock.mockResolvedValue(baseTask);
      getRepoByIdMock.mockResolvedValue(baseRepo);
      getCriteriaMock.mockResolvedValue([]);
      updateTaskMock.mockResolvedValue(baseTask);

      const boom = new Error("claude exploded");
      runClaudeMock.mockRejectedValue(boom);

      const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
      const runPromise = runTask({} as any, secrets, 1, 42);

      await expect(runPromise).rejects.toThrow("claude exploded");

      const callsAtFailure = renewTaskLeaseMock.mock.calls.length;
      jest.advanceTimersByTime(10 * 60_000);
      expect(renewTaskLeaseMock).toHaveBeenCalledTimes(callsAtFailure);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not start the renewal interval when the task or repo is missing", async () => {
    jest.useFakeTimers();
    try {
      getTaskByIdMock.mockResolvedValue(undefined);
      getRepoByIdMock.mockResolvedValue(baseRepo);

      const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
      const result = await runTask({} as any, secrets, 1, 42);
      expect(result).toBe("failed");

      jest.advanceTimersByTime(10 * 60_000);
      expect(renewTaskLeaseMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
