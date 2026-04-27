jest.mock("../src/secrets", () => {
  const store: Record<string, string | undefined> = {
    GH_PAT: "tok",
    ANTHROPIC_API_KEY: "x",
  };
  return {
    get: jest.fn((key: string) => store[key]),
    init: jest.fn(),
    set: jest.fn(),
    unset: jest.fn(),
    getSecretsFilePath: jest.fn(),
    __setStore: (override: Record<string, string | undefined>) => {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, override);
    },
  };
});

jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));

jest.mock("../src/db/tasks", () => ({
  getTaskById: jest.fn(),
  getChildTasks: jest.fn(),
  updateTask: jest.fn(),
  getTasksByRepoId: jest.fn(),
  renewTaskLease: jest.fn(),
  resolveTaskModel: jest.fn(),
}));

jest.mock("../src/db/acceptanceCriteria", () => ({
  getCriteriaByTaskId: jest.fn(),
}));

jest.mock("../src/db/taskEvents", () => ({
  recordEvent: jest.fn(),
}));

jest.mock("../src/db/taskNotes", () => ({
  getNotesForTask: jest.fn(),
  createNote: jest.fn(),
}));

jest.mock("../src/db/taskUsage", () => ({
  recordTaskUsage: jest.fn(),
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

// The mount manifest builder is exercised in mountManifest.test.ts. Here we
// just need taskRunner's wiring to receive *some* manifest so it can derive
// workDir + contextMounts to hand off to runClaudeOnTask.
jest.mock("../src/services/mountManifest", () => ({
  buildMountManifest: jest.fn(),
}));

jest.mock("../src/services/webhookDelivery", () => ({
  triggerWebhooks: jest.fn(),
}));

jest.mock("../src/services/imageBuilder", () => ({
  ensureRunnerImage: jest.fn().mockResolvedValue({
    status: "ready",
    hash: "abc123",
    startedAt: null,
    finishedAt: null,
    error: null,
  }),
}));

jest.mock("../src/services/dockerProbe", () => ({
  refreshDockerState: jest.fn().mockResolvedValue({
    available: true,
    error: null,
    lastCheckedAt: null,
  }),
}));

import { getRepoById } from "../src/db/repos";
import {
  getTaskById,
  updateTask,
  getChildTasks,
  getTasksByRepoId,
  renewTaskLease,
  resolveTaskModel,
} from "../src/db/tasks";
import { getCriteriaByTaskId } from "../src/db/acceptanceCriteria";
import { recordEvent } from "../src/db/taskEvents";
import { createNote, getNotesForTask } from "../src/db/taskNotes";
import { recordTaskUsage } from "../src/db/taskUsage";
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
import { buildMountManifest } from "../src/services/mountManifest";
import { triggerWebhooks } from "../src/services/webhookDelivery";
import { refreshDockerState } from "../src/services/dockerProbe";
import { ensureRunnerImage } from "../src/services/imageBuilder";
import { runTask } from "../src/services/taskRunner";

const getTaskByIdMock = getTaskById as jest.Mock;
const getRepoByIdMock = getRepoById as jest.Mock;
const getCriteriaMock = getCriteriaByTaskId as jest.Mock;
const updateTaskMock = updateTask as jest.Mock;
const runClaudeMock = runClaudeOnTask as jest.Mock;
const getChildTasksMock = getChildTasks as jest.Mock;
const getTasksByRepoIdMock = getTasksByRepoId as jest.Mock;
const renewTaskLeaseMock = renewTaskLease as jest.Mock;
const resolveTaskModelMock = resolveTaskModel as jest.Mock;
const recordEventMock = recordEvent as jest.Mock;
const getNotesForTaskMock = getNotesForTask as jest.Mock;
const createNoteMock = createNote as jest.Mock;
const recordTaskUsageMock = recordTaskUsage as jest.Mock;
const cloneOrPullMock = cloneOrPull as jest.Mock;
const checkoutBaseBranchMock = checkoutBaseBranch as jest.Mock;
const createTaskBranchMock = createTaskBranch as jest.Mock;
const commitAndPushTaskMock = commitAndPushTask as jest.Mock;
const mergeTaskIntoBaseMock = mergeTaskIntoBase as jest.Mock;
const hasUncommittedChangesMock = hasUncommittedChanges as jest.Mock;
const createPullRequestMock = createPullRequest as jest.Mock;
const triggerWebhooksMock = triggerWebhooks as jest.Mock;

const buildMountManifestMock = buildMountManifest as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getChildTasksMock.mockResolvedValue([]);
  getTasksByRepoIdMock.mockResolvedValue([]);
  renewTaskLeaseMock.mockResolvedValue(undefined);
  recordEventMock.mockResolvedValue(undefined);
  getNotesForTaskMock.mockResolvedValue([]);
  createNoteMock.mockResolvedValue({ id: 1 });
  recordTaskUsageMock.mockResolvedValue({ id: 1 });
  resolveTaskModelMock.mockResolvedValue("claude-opus-4-7");
  // Default manifest mirrors the on-disk path the pre-Phase-10 taskRunner
  // computed inline, so existing assertions keep working unchanged.
  buildMountManifestMock.mockImplementation(async (_db, repo, reposPath) => ({
    primary: {
      hostPath: repo.is_local_folder
        ? repo.local_path
        : `${reposPath}/${repo.owner}/${repo.repo_name}`,
      containerPath: "/workspace",
      mode: "rw",
    },
    context: [],
  }));
});

describe("runTask Docker availability", () => {
  it("halts (without claiming retries or running claude) when Docker is unavailable", async () => {
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
    (refreshDockerState as jest.Mock).mockResolvedValueOnce({
      available: false,
      error: "Cannot connect to the Docker daemon",
      lastCheckedAt: new Date().toISOString(),
    });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runTask({} as any, secrets, 1, 42);
      expect(result).toBe("halted");
    } finally {
      logSpy.mockRestore();
    }

    // Image build and claude run must not have been kicked off when Docker
    // is unavailable — otherwise the user would see misleading
    // "build failed" errors and the task would burn a retry attempt.
    expect(ensureRunnerImage).not.toHaveBeenCalled();
    expect(runClaudeMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
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

// ---------------------------------------------------------------------------
// Mount manifest wiring (Phase 10, task #315): the per-task mount manifest is
// the SOLE source of truth for what host paths are exposed to the runner.
// taskRunner must build it and forward both halves to runClaudeOnTask:
//   - manifest.primary.hostPath → workDir (bind-mounted at /workspace)
//   - manifest.context           → contextMounts (one bind mount per direct link)
// Anything not in the manifest is invisible to the container.
// ---------------------------------------------------------------------------
describe("runTask mount manifest wiring", () => {
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

  it("builds the manifest with the running repo and the configured REPOS_PATH", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/repos", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(buildMountManifestMock).toHaveBeenCalledTimes(1);
    expect(buildMountManifestMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 1 }),
      "/repos"
    );
  });

  it("forwards manifest.primary.hostPath as workDir (so /workspace is the manifest's primary mount)", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    buildMountManifestMock.mockResolvedValueOnce({
      primary: { hostPath: "/custom/path", containerPath: "/workspace", mode: "rw" },
      context: [],
    });

    const secrets: any = { REPOS_PATH: "/repos", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(runClaudeMock.mock.calls[0][0].workDir).toBe("/custom/path");
  });

  it("forwards manifest.context to runClaudeOnTask as contextMounts (verbatim, in order)", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const contextMounts = [
      { hostPath: "/repos/o/lib-a", containerPath: "/context/lib-a", mode: "ro" as const },
      { hostPath: "/repos/o/lib-b", containerPath: "/context/lib-b", mode: "rw" as const },
    ];
    buildMountManifestMock.mockResolvedValueOnce({
      primary: { hostPath: "/tmp/repo", containerPath: "/workspace", mode: "rw" },
      context: contextMounts,
    });

    const secrets: any = { REPOS_PATH: "/repos", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(runClaudeMock.mock.calls[0][0].contextMounts).toEqual(contextMounts);
  });

  it("forwards an empty contextMounts array when the primary has no links (no extra host paths leaked)", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    buildMountManifestMock.mockResolvedValueOnce({
      primary: { hostPath: "/tmp/repo", containerPath: "/workspace", mode: "rw" },
      context: [],
    });

    const secrets: any = { REPOS_PATH: "/repos", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(runClaudeMock.mock.calls[0][0].contextMounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Notes inclusion in TaskPayload (task #202): runTask must surface every note
// visible to the running task — per the visibility rules baked into
// getNotesForTask — on the payload handed to the agent. The agent depends on
// this to read context/warnings left by previous agents and by users.
// ---------------------------------------------------------------------------
describe("runTask notes inclusion", () => {
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

  function setupHappyPathMocks() {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);
  }

  it("calls getNotesForTask with the running task's id (so visibility is resolved against the correct task)", async () => {
    setupHappyPathMocks();

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(getNotesForTaskMock).toHaveBeenCalledTimes(1);
    expect(getNotesForTaskMock).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("includes a notes array on TaskPayload populated from getNotesForTask", async () => {
    const fixedDate = new Date("2026-04-25T12:00:00.000Z");
    getNotesForTaskMock.mockResolvedValue([
      {
        id: 100,
        task_id: 42,
        author: "agent",
        visibility: "siblings",
        tags: ["context"],
        content: "ran lint already",
        created_at: fixedDate,
      },
      {
        id: 101,
        task_id: 7,
        author: "user",
        visibility: "all",
        tags: [],
        content: "skip the legacy adapter",
        created_at: fixedDate,
      },
    ]);
    setupHappyPathMocks();

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const payload = runClaudeMock.mock.calls[0]?.[0]?.taskPayload;
    expect(payload).toBeDefined();
    expect(Array.isArray(payload.task.notes)).toBe(true);
    expect(payload.task.notes).toHaveLength(2);
    expect(payload.task.notes[0]).toMatchObject({
      id: 100,
      task_id: 42,
      author: "agent",
      visibility: "siblings",
      tags: ["context"],
      content: "ran lint already",
    });
    expect(payload.task.notes[1]).toMatchObject({
      id: 101,
      task_id: 7,
      author: "user",
      visibility: "all",
      tags: [],
      content: "skip the legacy adapter",
    });
  });

  it("serializes Date created_at values to ISO strings so the payload is plain-JSON safe for the agent prompt", async () => {
    const fixedDate = new Date("2026-04-25T12:00:00.000Z");
    getNotesForTaskMock.mockResolvedValue([
      {
        id: 1,
        task_id: 42,
        author: "agent",
        visibility: "self",
        tags: [],
        content: "n",
        created_at: fixedDate,
      },
    ]);
    setupHappyPathMocks();

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const payload = runClaudeMock.mock.calls[0]?.[0]?.taskPayload;
    expect(payload.task.notes[0].created_at).toBe("2026-04-25T12:00:00.000Z");
  });

  it("normalizes a missing tags field to an empty array (defensive against historical rows)", async () => {
    getNotesForTaskMock.mockResolvedValue([
      {
        id: 1,
        task_id: 42,
        author: "agent",
        visibility: "self",
        // no tags field
        content: "legacy row",
        created_at: new Date("2026-04-25T12:00:00.000Z"),
      },
    ]);
    setupHappyPathMocks();

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const payload = runClaudeMock.mock.calls[0]?.[0]?.taskPayload;
    expect(payload.task.notes[0].tags).toEqual([]);
  });

  it("emits an empty notes array (not undefined) when no notes are visible — so the agent prompt always has the section", async () => {
    getNotesForTaskMock.mockResolvedValue([]);
    setupHappyPathMocks();

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const payload = runClaudeMock.mock.calls[0]?.[0]?.taskPayload;
    expect(payload.task.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Agent NOTES_TO_SAVE persistence (task #203): when claudeRunner returns a
// `notes` array on the result (parsed from the agent's structured output),
// taskRunner must persist each one via createNote with author='agent' and the
// running task's id — but only when the agent run succeeds.
// ---------------------------------------------------------------------------
describe("runTask persists agent notes (NOTES_TO_SAVE protocol)", () => {
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

  function setupHappyPathMocks() {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    updateTaskMock.mockResolvedValue(baseTask);
  }

  it("persists each agent-emitted note via createNote with author='agent' and task_id of the running task", async () => {
    setupHappyPathMocks();
    runClaudeMock.mockResolvedValue({
      success: true,
      output: "ok",
      notes: [
        { visibility: "siblings", tags: ["context"], content: "watch order" },
        { visibility: "all", content: "skip the legacy adapter" },
      ],
    });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(createNoteMock).toHaveBeenCalledTimes(2);
    expect(createNoteMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      task_id: 42,
      author: "agent",
      visibility: "siblings",
      content: "watch order",
      tags: ["context"],
    });
    expect(createNoteMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      task_id: 42,
      author: "agent",
      visibility: "all",
      content: "skip the legacy adapter",
      tags: undefined,
    });
  });

  it("does NOT persist agent notes when the agent run fails (no point persisting partial work)", async () => {
    // retry_count = 2 → MAX_ATTEMPTS=3 means this is the final attempt; runTask
    // resolves to 'halted' after recording the failure. In any failure mode, no
    // createNote calls should fire.
    getTaskByIdMock.mockResolvedValue({ ...baseTask, retry_count: 2 });
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    updateTaskMock.mockResolvedValue(baseTask);
    runClaudeMock.mockResolvedValue({
      success: false,
      output: "boom",
      notes: [{ visibility: "all", content: "should not persist" }],
    });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);
    expect(result).toBe("halted");
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("does not call createNote at all when the agent emits no notes (empty array)", async () => {
    setupHappyPathMocks();
    runClaudeMock.mockResolvedValue({ success: true, output: "ok", notes: [] });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("a failure to persist one note does not abort the task (the other notes and downstream steps still run)", async () => {
    setupHappyPathMocks();
    runClaudeMock.mockResolvedValue({
      success: true,
      output: "ok",
      notes: [
        { visibility: "siblings", content: "first" },
        { visibility: "all", content: "second" },
      ],
    });
    // First createNote rejects, second resolves. The task should still finish.
    createNoteMock
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ id: 2 });
    // Silence the expected error log.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
      const result = await runTask({} as any, secrets, 1, 42);

      expect(result).toBe("success");
      expect(createNoteMock).toHaveBeenCalledTimes(2);
      // The status_change to 'done' must still be recorded — note persistence
      // failures shouldn't block task completion.
      const statusDone = recordEventMock.mock.calls.find(
        (c) =>
          c[1] === 42 &&
          c[2] === "status_change" &&
          (c[3] as { to?: string })?.to === "done"
      );
      expect(statusDone).toBeDefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Token usage persistence (task #218): runTask records a task_usage row
// whenever the agent run produces a usage block on the result. The row scopes
// the usage to both task_id and repo_id so per-task and per-repo aggregations
// don't have to JOIN tasks at query time.
// ---------------------------------------------------------------------------
describe("runTask records token usage after each agent run", () => {
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

  const sampleUsage = {
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 1000,
  };

  function setupHappyPathMocks() {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    updateTaskMock.mockResolvedValue(baseTask);
  }

  it("calls recordTaskUsage with task_id, repo_id, and the usage block from the agent result", async () => {
    setupHappyPathMocks();
    runClaudeMock.mockResolvedValue({
      success: true,
      output: "ok",
      notes: [],
      usage: sampleUsage,
    });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(recordTaskUsageMock).toHaveBeenCalledTimes(1);
    expect(recordTaskUsageMock).toHaveBeenCalledWith(expect.anything(), {
      task_id: 42,
      repo_id: 1,
      usage: sampleUsage,
    });
  });

  it("does NOT call recordTaskUsage when the agent result has usage: null (no usable info from the CLI)", async () => {
    setupHappyPathMocks();
    runClaudeMock.mockResolvedValue({
      success: true,
      output: "ok",
      notes: [],
      usage: null,
    });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(recordTaskUsageMock).not.toHaveBeenCalled();
  });

  it("records usage on a FAILED agent run too (failed runs cost tokens — per-repo totals must reflect that)", async () => {
    // retry_count = 2 → MAX_ATTEMPTS=3 means this is the final attempt; the
    // run resolves to 'halted' but should still persist usage before bailing.
    getTaskByIdMock.mockResolvedValue({ ...baseTask, retry_count: 2 });
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    updateTaskMock.mockResolvedValue(baseTask);
    runClaudeMock.mockResolvedValue({
      success: false,
      output: "boom",
      notes: [],
      usage: sampleUsage,
    });

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("halted");
    expect(recordTaskUsageMock).toHaveBeenCalledWith(expect.anything(), {
      task_id: 42,
      repo_id: 1,
      usage: sampleUsage,
    });
  });

  it("a failure inside recordTaskUsage does not abort the task (usage tracking is best-effort)", async () => {
    setupHappyPathMocks();
    runClaudeMock.mockResolvedValue({
      success: true,
      output: "ok",
      notes: [],
      usage: sampleUsage,
    });
    recordTaskUsageMock.mockRejectedValueOnce(new Error("db down"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
      const result = await runTask({} as any, secrets, 1, 42);

      expect(result).toBe("success");
      // status_change to 'done' must still be recorded — usage failures must
      // not block the task from completing.
      const statusDone = recordEventMock.mock.calls.find(
        (c) =>
          c[1] === 42 &&
          c[2] === "status_change" &&
          (c[3] as { to?: string })?.to === "done"
      );
      expect(statusDone).toBeDefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Webhook firing on task state changes (task #219): runTask must fire the
// configured webhook events at exactly the moments the task transitions
// through done / failed (intermediate retry) / halted (terminal failure). The
// firing is fire-and-forget — task-pipeline progress must not be blocked by
// webhook delivery.
// ---------------------------------------------------------------------------
describe("runTask webhook firing", () => {
  const baseTask = {
    id: 42,
    repo_id: 1,
    parent_id: null,
    title: "Add login",
    description: "",
    order_position: 0,
    status: "active",
    retry_count: 0,
    pr_url: null,
    worker_id: "host:123",
    leased_until: new Date(),
    created_at: new Date(),
  };
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

  it("fires a 'done' webhook when a local-folder task succeeds", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("success");
    const doneCalls = triggerWebhooksMock.mock.calls.filter(
      (c) => c[3] === "done"
    );
    expect(doneCalls).toHaveLength(1);
    // The Task passed to triggerWebhooks reflects the *new* status so payload
    // builders don't have to guess what the task ended up as.
    expect(doneCalls[0][2]).toMatchObject({ id: 42, status: "done" });
    // The Repo argument is also forwarded so the payload can render owner/repo.
    expect(doneCalls[0][1]).toMatchObject({ id: 1 });
  });

  it("fires a 'done' webhook on the merge-to-base success path (require_pr=false on a github repo)", async () => {
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

    const doneCalls = triggerWebhooksMock.mock.calls.filter(
      (c) => c[3] === "done"
    );
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][2]).toMatchObject({ status: "done" });
  });

  it("fires a 'done' webhook on the PR-opened success path (require_pr=true on a github repo) with pr_url populated", async () => {
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

    const doneCalls = triggerWebhooksMock.mock.calls.filter(
      (c) => c[3] === "done"
    );
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][2]).toMatchObject({
      status: "done",
      pr_url: "https://gh/pr/1",
    });
  });

  it("fires a 'failed' webhook on a non-final attempt failure (intermediate retry path)", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: false, output: "boom" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("failed");
    const events = triggerWebhooksMock.mock.calls.map((c) => c[3]);
    expect(events).toContain("failed");
    // A non-final attempt must NOT also fire 'halted' or 'done'.
    expect(events).not.toContain("halted");
    expect(events).not.toContain("done");
  });

  it("fires a 'halted' webhook (and not 'done') when the final attempt fails", async () => {
    // retry_count = 2 → MAX_ATTEMPTS=3 means this is the final attempt.
    getTaskByIdMock.mockResolvedValue({ ...baseTask, retry_count: 2 });
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: false, output: "boom" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("halted");
    const events = triggerWebhooksMock.mock.calls.map((c) => c[3]);
    expect(events).toContain("halted");
    expect(events).not.toContain("done");
    // The Task forwarded with the 'halted' event reflects the final 'failed' status.
    const haltedCall = triggerWebhooksMock.mock.calls.find((c) => c[3] === "halted");
    expect(haltedCall![2]).toMatchObject({ status: "failed" });
  });

  it("does not fire any webhook when claude succeeds — er, wait, that case fires 'done'. We assert it's exactly one call total on the success path.", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(localFolderRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    // No spurious 'failed' or 'halted' calls on the success path.
    const eventsFired = triggerWebhooksMock.mock.calls.map((c) => c[3]);
    expect(eventsFired).toEqual(["done"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 11 (task #321): taskRunner resolves the effective Claude model at
// task start (via resolveTaskModel) and forwards it to runClaudeOnTask so the
// docker invocation can include --model <id>. The same value is logged on
// claude_started so the events timeline shows which model the run used.
// ---------------------------------------------------------------------------
describe("runTask resolves and forwards the effective model", () => {
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

  it("calls resolveTaskModel with the running task's id", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(resolveTaskModelMock).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("forwards the resolved model to runClaudeOnTask as `model`", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);
    resolveTaskModelMock.mockResolvedValueOnce("claude-sonnet-4-6");

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    expect(runClaudeMock.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("includes the resolved model in the claude_started event payload (so the events timeline shows what was used)", async () => {
    getTaskByIdMock.mockResolvedValue(baseTask);
    getRepoByIdMock.mockResolvedValue(baseRepo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(baseTask);
    resolveTaskModelMock.mockResolvedValueOnce("claude-haiku-4-5");

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    const claudeStarted = recordEventMock.mock.calls.find(
      (c) => c[1] === 42 && c[2] === "claude_started"
    );
    expect(claudeStarted).toBeDefined();
    expect(claudeStarted![3]).toMatchObject({ model: "claude-haiku-4-5" });
  });
});
