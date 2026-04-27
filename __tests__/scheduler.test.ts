import * as os from "os";

jest.mock("../src/db/repos", () => ({
  getActiveRepos: jest.fn(),
}));

jest.mock("../src/db/tasks", () => ({
  claimNextPendingLeafTask: jest.fn(),
  autoCompleteParentTasks: jest.fn(),
}));

jest.mock("../src/db/taskEvents", () => ({
  recordEvent: jest.fn(),
}));

jest.mock("../src/services/taskRunner", () => ({
  runTask: jest.fn(),
}));

jest.mock("../src/services/dockerProbe", () => ({
  refreshDockerState: jest.fn().mockResolvedValue({
    available: true,
    error: null,
    lastCheckedAt: null,
  }),
}));

jest.mock("../src/db/usageAggregations", () => ({
  getWeeklyTokens: jest.fn(),
}));

jest.mock("../src/db/settings", () => ({
  getSettings: jest.fn(),
}));

import { getActiveRepos } from "../src/db/repos";
import { claimNextPendingLeafTask } from "../src/db/tasks";
import { recordEvent } from "../src/db/taskEvents";
import { getWeeklyTokens } from "../src/db/usageAggregations";
import { getSettings } from "../src/db/settings";
import {
  buildWorkQueue,
  WORKER_ID,
  evaluateCapStatus,
} from "../src/services/scheduler";

const getActiveReposMock = getActiveRepos as jest.Mock;
const claimMock = claimNextPendingLeafTask as jest.Mock;
const recordEventMock = recordEvent as jest.Mock;
const getWeeklyTokensMock = getWeeklyTokens as jest.Mock;
const getSettingsMock = getSettings as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: cap is unlimited (null) so every test that doesn't care about
  // capping behaves like it did before token caps existed.
  getSettingsMock.mockResolvedValue({
    id: 1,
    default_model: "sonnet",
    weekly_token_cap: null,
    session_token_cap: null,
    updated_at: new Date(),
  });
  getWeeklyTokensMock.mockResolvedValue({
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
    total: 0,
  });
});

describe("WORKER_ID", () => {
  it("is a stable string derived from hostname and pid", () => {
    expect(WORKER_ID).toBe(`${os.hostname()}:${process.pid}`);
  });
});

describe("buildWorkQueue", () => {
  it("calls claimNextPendingLeafTask for each active repo with the worker id and lease", async () => {
    getActiveReposMock.mockResolvedValueOnce([
      { id: 1 },
      { id: 2 },
    ]);
    claimMock
      .mockResolvedValueOnce({ id: 100 })
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(claimMock).toHaveBeenNthCalledWith(1, fakeDb, 1, "worker-abc", 1800);
    expect(claimMock).toHaveBeenNthCalledWith(2, fakeDb, 2, "worker-abc", 1800);
    expect(queue).toEqual([
      { repoId: 1, taskId: 100 },
      { repoId: 2, taskId: 200 },
    ]);
  });

  it("skips repos that have no claimable task", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([{ repoId: 2, taskId: 200 }]);
  });

  it("defaults to the module-level WORKER_ID and 30-minute lease when no overrides are passed", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }]);
    claimMock.mockResolvedValueOnce({ id: 100 });

    const fakeDb = {} as any;
    await buildWorkQueue(fakeDb);

    expect(claimMock).toHaveBeenCalledWith(fakeDb, 1, WORKER_ID, 30 * 60);
  });

  it("records a 'claimed' event for each task that is successfully claimed", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce({ id: 100 })
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(recordEventMock).toHaveBeenCalledTimes(2);
    expect(recordEventMock).toHaveBeenNthCalledWith(
      1,
      fakeDb,
      100,
      "claimed",
      { worker_id: "worker-abc" }
    );
    expect(recordEventMock).toHaveBeenNthCalledWith(
      2,
      fakeDb,
      200,
      "claimed",
      { worker_id: "worker-abc" }
    );
  });

  it("does not record a 'claimed' event for repos that have no claimable task", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(recordEventMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).toHaveBeenCalledWith(
      fakeDb,
      200,
      "claimed",
      { worker_id: "worker-abc" }
    );
  });

  // ---------------------------------------------------------------------
  // Weekly cap (Phase 12) — the scheduler must stop claiming new tasks
  // when the trailing-7-day token total has reached the configured weekly
  // cap. In-flight tasks are unaffected: buildWorkQueue only decides which
  // tasks to *claim* this cycle; runTask runs after this returns.
  // ---------------------------------------------------------------------
  it("does not claim any tasks when weekly usage has reached the weekly cap", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 600,
      output: 400,
      cache_creation: 0,
      cache_read: 0,
      total: 1000,
    });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([]);
    expect(claimMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("treats usage exceeding the cap as capped (>=, not >) — even one token over still blocks new claims", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }]);
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 1001,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 1001,
    });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([]);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("claims tasks normally when the weekly cap is null (unlimited)", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }]);
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: new Date(),
    });
    // Even huge usage doesn't gate claims when cap is null — null means
    // "no cap configured", not "cap of zero".
    getWeeklyTokensMock.mockResolvedValue({
      input: 99_999_999,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 99_999_999,
    });
    claimMock.mockResolvedValueOnce({ id: 100 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([{ repoId: 1, taskId: 100 }]);
  });

  it("claims tasks normally when usage is below the cap", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }]);
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 500,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 500,
    });
    claimMock.mockResolvedValueOnce({ id: 100 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([{ repoId: 1, taskId: 100 }]);
    expect(recordEventMock).toHaveBeenCalledWith(
      fakeDb,
      100,
      "claimed",
      { worker_id: "worker-abc" }
    );
  });

  it("logs a [scheduler] capped line when claims are skipped due to the cap", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      getActiveReposMock.mockResolvedValueOnce([{ id: 1 }]);
      getSettingsMock.mockResolvedValue({
        id: 1,
        default_model: "sonnet",
        weekly_token_cap: 1000,
        session_token_cap: null,
        updated_at: new Date(),
      });
      getWeeklyTokensMock.mockResolvedValue({
        input: 1500,
        output: 0,
        cache_creation: 0,
        cache_read: 0,
        total: 1500,
      });

      const fakeDb = {} as any;
      await buildWorkQueue(fakeDb, "worker-abc", 1800);

      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some((m) => /\[scheduler\] capped/.test(m))
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("evaluateCapStatus", () => {
  it("returns capped=false when weekly_token_cap is null (unlimited)", async () => {
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: null,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 100,
      output: 100,
      cache_creation: 0,
      cache_read: 0,
      total: 200,
    });

    const status = await evaluateCapStatus({} as any);
    expect(status).toEqual({
      capped: false,
      weekly_total: 200,
      weekly_cap: null,
    });
  });

  it("returns capped=true when usage equals the cap (>= comparison)", async () => {
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 1000,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 1000,
    });

    const status = await evaluateCapStatus({} as any);
    expect(status).toEqual({
      capped: true,
      weekly_total: 1000,
      weekly_cap: 1000,
    });
  });

  it("returns capped=false when usage is strictly below the cap", async () => {
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 500,
      output: 499,
      cache_creation: 0,
      cache_read: 0,
      total: 999,
    });

    const status = await evaluateCapStatus({} as any);
    expect(status).toEqual({
      capped: false,
      weekly_total: 999,
      weekly_cap: 1000,
    });
  });

  it("passes the supplied `now` instant through to getWeeklyTokens so callers can pin the window", async () => {
    getSettingsMock.mockResolvedValue({
      id: 1,
      default_model: "sonnet",
      weekly_token_cap: 1000,
      session_token_cap: null,
      updated_at: new Date(),
    });
    getWeeklyTokensMock.mockResolvedValue({
      input: 0,
      output: 0,
      cache_creation: 0,
      cache_read: 0,
      total: 0,
    });

    const fixed = new Date("2026-04-26T12:00:00.000Z");
    await evaluateCapStatus({} as any, fixed);
    expect(getWeeklyTokensMock).toHaveBeenCalledWith({}, fixed);
  });
});
