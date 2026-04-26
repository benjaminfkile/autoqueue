import * as path from "path";

type GitMock = {
  dir: string;
  fetch: jest.Mock;
  pull: jest.Mock;
};

const mockState: {
  instances: GitMock[];
  fetchRejection: Error | null;
  pullRejection: Error | null;
} = {
  instances: [],
  fetchRejection: null,
  pullRejection: null,
};

jest.mock("simple-git", () => {
  return {
    __esModule: true,
    default: (dir: string) => {
      const git: GitMock = {
        dir,
        fetch: jest.fn().mockImplementation(async () => {
          if (mockState.fetchRejection) {
            const err = mockState.fetchRejection;
            throw err;
          }
        }),
        pull: jest.fn().mockImplementation(async () => {
          if (mockState.pullRejection) {
            const err = mockState.pullRejection;
            throw err;
          }
        }),
      };
      mockState.instances.push(git);
      return git;
    },
  };
});

const fsMockState = {
  existing: new Set<string>(),
};

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn((p: string) => fsMockState.existing.has(p)),
  };
});

jest.mock("../src/db/repos", () => ({
  getAllRepos: jest.fn(),
  updateRepo: jest.fn(),
}));

jest.mock("../src/db/appSettings", () => ({
  isPullWorkerPaused: jest.fn(),
}));

import { getAllRepos, updateRepo } from "../src/db/repos";
import { isPullWorkerPaused } from "../src/db/appSettings";
import { Repo } from "../src/interfaces";
import {
  _getFailureCount,
  _resetFailureCountsForTest,
  pullRepo,
  runPullCycle,
  startPullWorker,
  stopPullWorker,
} from "../src/services/pullWorker";

const getAllReposMock = getAllRepos as jest.Mock;
const updateRepoMock = updateRepo as jest.Mock;
const isPausedMock = isPullWorkerPaused as jest.Mock;

const REPOS_PATH = "/repos";

function repoFixture(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    owner: "octocat",
    repo_name: "hello",
    active: true,
    is_local_folder: false,
    clone_status: "ready",
    clone_error: null,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    github_token: null,
    local_path: null,
    on_failure: "halt_repo",
    max_retries: 0,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mockState.instances = [];
  mockState.fetchRejection = null;
  mockState.pullRejection = null;
  fsMockState.existing = new Set([
    path.join(REPOS_PATH, "octocat", "hello"),
    path.join(REPOS_PATH, "octocat", "world"),
    path.join(REPOS_PATH, "octocat", "third"),
  ]);
  getAllReposMock.mockReset();
  updateRepoMock.mockReset();
  isPausedMock.mockReset();
  isPausedMock.mockResolvedValue(false);
  _resetFailureCountsForTest();
});

afterEach(() => {
  stopPullWorker();
});

describe("pullRepo", () => {
  it("runs git fetch + git pull against the resolved clone path", async () => {
    const result = await pullRepo(REPOS_PATH, repoFixture());

    expect(result).toEqual({ ok: true });
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].dir).toBe(
      path.join(REPOS_PATH, "octocat", "hello")
    );
    expect(mockState.instances[0].fetch).toHaveBeenCalled();
    expect(mockState.instances[0].pull).toHaveBeenCalled();
  });

  it("returns ok without invoking git when the repo is a local folder", async () => {
    const result = await pullRepo(
      REPOS_PATH,
      repoFixture({ is_local_folder: true, owner: null, repo_name: null })
    );

    expect(result).toEqual({ ok: true });
    expect(mockState.instances).toHaveLength(0);
  });

  it("returns an error when the clone directory is missing on disk", async () => {
    fsMockState.existing.clear();

    const result = await pullRepo(REPOS_PATH, repoFixture());

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/clone directory missing/),
    });
    expect(mockState.instances).toHaveLength(0);
  });

  it("returns an error when fetch fails", async () => {
    mockState.fetchRejection = new Error("network down");

    const result = await pullRepo(REPOS_PATH, repoFixture());

    expect(result).toEqual({ ok: false, error: "network down" });
  });

  it("returns an error when pull fails", async () => {
    mockState.pullRejection = new Error("merge conflict");

    const result = await pullRepo(REPOS_PATH, repoFixture());

    expect(result).toEqual({ ok: false, error: "merge conflict" });
  });

  it("returns an error when the repo has no owner/repo_name (defensive — should not happen for git-backed)", async () => {
    const result = await pullRepo(
      REPOS_PATH,
      repoFixture({ owner: null, repo_name: null })
    );

    expect(result.ok).toBe(false);
  });
});

describe("runPullCycle", () => {
  it("skips entirely when the worker is paused", async () => {
    isPausedMock.mockResolvedValueOnce(true);

    await runPullCycle({} as any, REPOS_PATH);

    expect(getAllReposMock).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(0);
  });

  it("skips local-folder repos (nothing to pull) and inactive repos", async () => {
    getAllReposMock.mockResolvedValueOnce([
      repoFixture({ id: 1, is_local_folder: true }),
      repoFixture({ id: 2, active: false }),
      repoFixture({ id: 3 }),
    ]);

    await runPullCycle({} as any, REPOS_PATH);

    // Only the third repo should have triggered a git invocation.
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].dir).toBe(
      path.join(REPOS_PATH, "octocat", "hello")
    );
  });

  it("skips repos whose clone_status is not 'ready' (no working tree to pull into)", async () => {
    getAllReposMock.mockResolvedValueOnce([
      repoFixture({ id: 1, clone_status: "error" }),
      repoFixture({ id: 2, clone_status: "pending" }),
    ]);

    await runPullCycle({} as any, REPOS_PATH);

    expect(mockState.instances).toHaveLength(0);
    expect(updateRepoMock).not.toHaveBeenCalled();
  });

  it("invokes fetch+pull for every active git-backed ready repo", async () => {
    getAllReposMock.mockResolvedValueOnce([
      repoFixture({ id: 1, repo_name: "hello" }),
      repoFixture({ id: 2, repo_name: "world" }),
    ]);

    await runPullCycle({} as any, REPOS_PATH);

    expect(mockState.instances).toHaveLength(2);
    expect(mockState.instances[0].fetch).toHaveBeenCalled();
    expect(mockState.instances[0].pull).toHaveBeenCalled();
    expect(mockState.instances[1].fetch).toHaveBeenCalled();
    expect(mockState.instances[1].pull).toHaveBeenCalled();
  });

  it("does not promote clone_status='error' on a single transient failure (under threshold)", async () => {
    getAllReposMock.mockResolvedValueOnce([repoFixture({ id: 1 })]);
    mockState.pullRejection = new Error("temporary network blip");

    await runPullCycle({} as any, REPOS_PATH);

    expect(updateRepoMock).not.toHaveBeenCalled();
    expect(_getFailureCount(1)).toBe(1);
  });

  it("promotes clone_status='error' once the consecutive failure threshold is hit", async () => {
    mockState.pullRejection = new Error("auth failed");

    for (let i = 0; i < 3; i++) {
      getAllReposMock.mockResolvedValueOnce([repoFixture({ id: 1 })]);
      // eslint-disable-next-line no-await-in-loop
      await runPullCycle({} as any, REPOS_PATH);
    }

    expect(updateRepoMock).toHaveBeenCalledTimes(1);
    expect(updateRepoMock).toHaveBeenCalledWith(
      {},
      1,
      expect.objectContaining({
        clone_status: "error",
        clone_error: expect.stringMatching(/auth failed/),
      })
    );
    expect(_getFailureCount(1)).toBe(3);
  });

  it("clears the failure counter on a successful cycle so transient blips don't accumulate forever", async () => {
    // First cycle: failure
    mockState.pullRejection = new Error("temporary");
    getAllReposMock.mockResolvedValueOnce([repoFixture({ id: 1 })]);
    await runPullCycle({} as any, REPOS_PATH);
    expect(_getFailureCount(1)).toBe(1);

    // Second cycle: success — counter resets.
    mockState.pullRejection = null;
    getAllReposMock.mockResolvedValueOnce([repoFixture({ id: 1 })]);
    await runPullCycle({} as any, REPOS_PATH);
    expect(_getFailureCount(1)).toBe(0);
    expect(updateRepoMock).not.toHaveBeenCalled();
  });

  it("tracks failure counts independently per repo", async () => {
    mockState.pullRejection = new Error("boom");
    getAllReposMock.mockResolvedValueOnce([
      repoFixture({ id: 1, repo_name: "hello" }),
      repoFixture({ id: 2, repo_name: "world" }),
    ]);

    await runPullCycle({} as any, REPOS_PATH);

    expect(_getFailureCount(1)).toBe(1);
    expect(_getFailureCount(2)).toBe(1);
  });
});

describe("startPullWorker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopPullWorker();
    jest.useRealTimers();
  });

  it("does nothing when REPOS_PATH is not configured (no timer scheduled)", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    startPullWorker({} as any, {
      NODE_ENV: "development",
      PORT: "8000",
      API_KEY_HASH: "",
      REPOS_PATH: "",
    } as any);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("schedules the cycle on the configured interval", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    getAllReposMock.mockResolvedValue([]);

    startPullWorker({} as any, {
      NODE_ENV: "development",
      PORT: "8000",
      API_KEY_HASH: "",
      REPOS_PATH: REPOS_PATH,
      PULL_WORKER_INTERVAL_SECONDS: "120",
    } as any);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(120 * 1000);
  });

  it("uses the default interval (600s) when PULL_WORKER_INTERVAL_SECONDS is unset", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    getAllReposMock.mockResolvedValue([]);

    startPullWorker({} as any, {
      NODE_ENV: "development",
      PORT: "8000",
      API_KEY_HASH: "",
      REPOS_PATH: REPOS_PATH,
    } as any);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(600 * 1000);
  });

  it("falls back to the default when the configured interval is invalid", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    getAllReposMock.mockResolvedValue([]);

    startPullWorker({} as any, {
      NODE_ENV: "development",
      PORT: "8000",
      API_KEY_HASH: "",
      REPOS_PATH: REPOS_PATH,
      PULL_WORKER_INTERVAL_SECONDS: "not-a-number",
    } as any);

    expect(setIntervalSpy.mock.calls[0][1]).toBe(600 * 1000);
  });

  it("does not double-schedule when called twice (idempotent)", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    getAllReposMock.mockResolvedValue([]);

    const args = {
      NODE_ENV: "development",
      PORT: "8000",
      API_KEY_HASH: "",
      REPOS_PATH: REPOS_PATH,
    } as any;

    startPullWorker({} as any, args);
    startPullWorker({} as any, args);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
