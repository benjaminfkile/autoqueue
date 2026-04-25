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

jest.mock("../src/db/taskEvents", () => ({
  recordEvent: jest.fn(),
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
import { recordEvent } from "../src/db/taskEvents";
import {
  cloneOrPull,
  checkoutBaseBranch,
  createTaskBranch,
  commitAndPushTask,
  mergeTaskIntoBase,
  hasUncommittedChanges,
} from "../src/services/git";
import { createPullRequest } from "../src/services/github";
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
const recordEventMock = recordEvent as jest.Mock;
const cloneOrPullMock = cloneOrPull as jest.Mock;
const checkoutBaseBranchMock = checkoutBaseBranch as jest.Mock;
const createTaskBranchMock = createTaskBranch as jest.Mock;
const commitAndPushTaskMock = commitAndPushTask as jest.Mock;
const mergeTaskIntoBaseMock = mergeTaskIntoBase as jest.Mock;
const hasUncommittedChangesMock = hasUncommittedChanges as jest.Mock;
const createPullRequestMock = createPullRequest as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getChildTasksMock.mockResolvedValue([]);
  getTasksByRepoIdMock.mockResolvedValue([]);
  renewTaskLeaseMock.mockResolvedValue(undefined);
  recordEventMock.mockResolvedValue(undefined);
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

// ---------------------------------------------------------------------------
// Event emission (task #190): taskRunner records a structured event timeline
// for every meaningful state transition / side-effect. The events are observable
// via getEventsByTaskId and used by the dashboard to show what happened when a
// task went sideways. We assert on event NAMES here — payload shape can evolve.
// ---------------------------------------------------------------------------
describe("runTask event emission", () => {
  function recordedEvents(): string[] {
    return recordEventMock.mock.calls.map((call) => call[2] as string);
  }

  function eventForTask(taskId: number, name: string): unknown[] | undefined {
    const found = recordEventMock.mock.calls.find(
      (call) => call[1] === taskId && call[2] === name
    );
    return found;
  }

  const localFolderRepo = {
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

  const githubRepo = {
    id: 2,
    owner: "acme",
    repo_name: "widgets",
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    github_token: null,
    is_local_folder: false,
    local_path: null,
    created_at: new Date(),
  };

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

  it("records claude_started and claude_finished around the runClaudeOnTask invocation", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const events = recordedEvents();
    expect(events).toContain("claude_started");
    expect(events).toContain("claude_finished");
    expect(events.indexOf("claude_started")).toBeLessThan(
      events.indexOf("claude_finished")
    );
  });

  it("records a status_change event when an ancestor is activated from pending → active", async () => {
    const leaf = { ...baseTask, parent_id: 10 };
    const ancestor = { ...baseTask, id: 10, parent_id: null, status: "pending" };

    getTaskByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 42) return leaf;
      if (id === 10) return ancestor;
      return undefined;
    });
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(leaf);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(eventForTask(10, "status_change")).toBeDefined();
  });

  it("records branch_created when running on a github repo (branch is created on disk)", async () => {
    getTaskByIdMock.mockResolvedValue({ ...baseTask, repo_id: 2 });
    getRepoByIdMock.mockResolvedValue(githubRepo);
    getCriteriaMock.mockResolvedValue([]);
    createTaskBranchMock.mockResolvedValue("task-42");
    cloneOrPullMock.mockResolvedValue(undefined);
    checkoutBaseBranchMock.mockResolvedValue(undefined);
    hasUncommittedChangesMock.mockResolvedValue(false);
    mergeTaskIntoBaseMock.mockResolvedValue(undefined);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = {
      REPOS_PATH: "/tmp",
      ANTHROPIC_API_KEY: "x",
      GH_PAT: "tok",
    };
    await runTask({} as any, secrets, 2, 42);

    const branchCreated = eventForTask(42, "branch_created");
    expect(branchCreated).toBeDefined();
    expect(branchCreated![3]).toMatchObject({ branch: "task-42" });
  });

  it("records commit_pushed when there are uncommitted changes after a successful agent run", async () => {
    getTaskByIdMock.mockResolvedValue({ ...baseTask, repo_id: 2 });
    getRepoByIdMock.mockResolvedValue(githubRepo);
    getCriteriaMock.mockResolvedValue([]);
    createTaskBranchMock.mockResolvedValue("task-42");
    cloneOrPullMock.mockResolvedValue(undefined);
    checkoutBaseBranchMock.mockResolvedValue(undefined);
    hasUncommittedChangesMock.mockResolvedValue(true);
    commitAndPushTaskMock.mockResolvedValue(undefined);
    mergeTaskIntoBaseMock.mockResolvedValue(undefined);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = {
      REPOS_PATH: "/tmp",
      ANTHROPIC_API_KEY: "x",
      GH_PAT: "tok",
    };
    await runTask({} as any, secrets, 2, 42);

    expect(eventForTask(42, "commit_pushed")).toBeDefined();
  });

  it("records pr_opened when require_pr is true on the repo", async () => {
    const prRepo = { ...githubRepo, require_pr: true };
    getTaskByIdMock.mockResolvedValue({ ...baseTask, repo_id: 2 });
    getRepoByIdMock.mockResolvedValue(prRepo);
    getCriteriaMock.mockResolvedValue([]);
    createTaskBranchMock.mockResolvedValue("task-42");
    cloneOrPullMock.mockResolvedValue(undefined);
    checkoutBaseBranchMock.mockResolvedValue(undefined);
    hasUncommittedChangesMock.mockResolvedValue(false);
    createPullRequestMock.mockResolvedValue({ url: "https://gh/pr/1" });
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = {
      REPOS_PATH: "/tmp",
      ANTHROPIC_API_KEY: "x",
      GH_PAT: "tok",
    };
    await runTask({} as any, secrets, 2, 42);

    const prOpened = eventForTask(42, "pr_opened");
    expect(prOpened).toBeDefined();
    expect(prOpened![3]).toMatchObject({ url: "https://gh/pr/1" });
  });

  it("records a 'retry' event (and not 'failed') when claude fails on a non-final attempt", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: false, output: "boom" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("failed");
    expect(recordedEvents()).toContain("retry");
    expect(recordedEvents()).not.toContain("failed");
  });

  it("records a 'failed' event and a status_change to 'failed' when the final attempt fails", async () => {
    // retry_count = MAX_ATTEMPTS - 1 = 2 → next attempt is 3 (the final one).
    getTaskByIdMock.mockResolvedValue({ ...baseTask, retry_count: 2 });
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: false, output: "boom" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("halted");
    expect(recordedEvents()).toContain("failed");

    // status_change to 'failed' should have been emitted on the leaf.
    const statusChangeToFailed = recordEventMock.mock.calls.find(
      (call) =>
        call[1] === 42 &&
        call[2] === "status_change" &&
        (call[3] as { to?: string })?.to === "failed"
    );
    expect(statusChangeToFailed).toBeDefined();
  });

  it("records a status_change to 'done' on success (local folder path)", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const statusChangeToDone = recordEventMock.mock.calls.find(
      (call) =>
        call[1] === 42 &&
        call[2] === "status_change" &&
        (call[3] as { to?: string })?.to === "done"
    );
    expect(statusChangeToDone).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Log capture (task #191): runTask passes a per-task log file path to the
// agent runner and wires up onFirstByte to set log_path on the task.
// ---------------------------------------------------------------------------
describe("runTask log capture", () => {
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

  it("passes a logFilePath of <REPOS_PATH>/_logs/task-<id>.log to runClaudeOnTask", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/repos", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const call = runClaudeMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.logFilePath).toMatch(/[\\/]_logs[\\/]task-42\.log$/);
    expect(call.logFilePath.startsWith("/repos") || call.logFilePath.startsWith("\\repos")).toBe(true);
    expect(typeof call.onFirstByte).toBe("function");
  });

  it("invoking onFirstByte triggers updateTask with log_path set to the log file path", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);

    let capturedLogPath = "";
    runClaudeMock.mockImplementation(async (opts: any) => {
      capturedLogPath = opts.logFilePath;
      opts.onFirstByte();
      return { success: true, output: "ok" };
    });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/repos", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    // Allow the deferred update from onFirstByte to settle.
    await new Promise((r) => setImmediate(r));

    const logPathUpdate = updateTaskMock.mock.calls.find(
      ([, id, data]) => id === 42 && data && data.log_path === capturedLogPath
    );
    expect(logPathUpdate).toBeDefined();
  });
});
