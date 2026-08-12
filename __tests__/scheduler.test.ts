import * as os from "os";

jest.mock("../src/db/repos", () => ({
  getActiveRepos: jest.fn(),
}));

jest.mock("../src/db/tasks", () => ({
  claimNextPendingLeafTask: jest.fn(),
  autoCompleteParentTasks: jest.fn(),
  hasActiveLeasedTask: jest.fn(),
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
import { claimNextPendingLeafTask, hasActiveLeasedTask } from "../src/db/tasks";
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
const hasActiveLeasedTaskMock = hasActiveLeasedTask as jest.Mock;

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
  // Default: no valid-lease active task in flight, so buildWorkQueue is free
  // to claim. Individual tests override when they need the single-task guard
  // to trip.
  hasActiveLeasedTaskMock.mockResolvedValue(false);
  // clearAllMocks does NOT clear mockResolvedValueOnce queues in Jest 29 —
  // leftover once-values from a prior test would surface in the next call
  // and silently corrupt assertions. Fully reset the mocks whose per-call
  // return values these tests exercise.
  claimMock.mockReset();
  getActiveReposMock.mockReset();
  recordEventMock.mockReset();
});

describe("WORKER_ID", () => {
  it("is a stable string derived from hostname and pid", () => {
    expect(WORKER_ID).toBe(`${os.hostname()}:${process.pid}`);
  });
});

describe("buildWorkQueue", () => {
  // -------------------------------------------------------------------------
  // Task #29 — strict single-task execution. buildWorkQueue must claim AT
  // MOST ONE task across all repos per cycle. The tests below pin down every
  // face of that invariant (multi-repo one-at-a-time, waiting tasks stay
  // pending, active-in-flight guard, repo order, cap gate, default arg
  // wiring).
  // -------------------------------------------------------------------------

  it("claims AT MOST ONE task across all repos per cycle — a second repo with a runnable task is left untouched (AC #112, #113, #116)", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce({ id: 100 })
      // A second call would return a task, but it must NEVER be made — the
      // first successful claim ends the cycle so only one task is ever
      // marked 'active' at a time.
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(claimMock).toHaveBeenNthCalledWith(1, fakeDb, 1, "worker-abc", 1800);
    expect(queue).toEqual([{ repoId: 1, taskId: 100 }]);
  });

  it("skips over a repo with no claimable task and claims the first eligible task from the next repo in order (AC #116)", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(claimMock).toHaveBeenCalledTimes(2);
    expect(queue).toEqual([{ repoId: 2, taskId: 200 }]);
  });

  it("claims nothing when a task is already 'active' with a valid lease (AC #112, #114) — waiting work stays pending", async () => {
    // A task from a prior cycle or another worker is still in flight. The
    // single-task guard must trip and no new claims may happen — even though
    // repos have runnable tasks. Waiting work stays 'pending' with no lease
    // (so no lease can expire while it queues).
    hasActiveLeasedTaskMock.mockResolvedValueOnce(true);
    // getActiveRepos and claim would return work if consulted — they must
    // NOT be consulted at all.
    getActiveReposMock.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    claimMock.mockResolvedValue({ id: 999 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([]);
    expect(claimMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("iterates active repos in the order returned by getActiveRepos when picking the single task to claim (AC #116)", async () => {
    // First repo has nothing, second repo has work — claim the second, do
    // not consult the third even though it would also return a task.
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 200 })
      .mockResolvedValueOnce({ id: 300 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(claimMock).toHaveBeenCalledTimes(2);
    expect(claimMock).toHaveBeenNthCalledWith(1, fakeDb, 1, "worker-abc", 1800);
    expect(claimMock).toHaveBeenNthCalledWith(2, fakeDb, 2, "worker-abc", 1800);
    expect(queue).toEqual([{ repoId: 2, taskId: 200 }]);
  });

  it("defaults to the module-level WORKER_ID and 30-minute lease when no overrides are passed", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }]);
    claimMock.mockResolvedValueOnce({ id: 100 });

    const fakeDb = {} as any;
    await buildWorkQueue(fakeDb);

    expect(claimMock).toHaveBeenCalledWith(fakeDb, 1, WORKER_ID, 30 * 60);
  });

  it("records exactly one 'claimed' event for the single task claimed this cycle", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce({ id: 100 })
      .mockResolvedValueOnce({ id: 200 });

    const fakeDb = {} as any;
    await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(recordEventMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).toHaveBeenCalledWith(
      fakeDb,
      100,
      "claimed",
      { worker_id: "worker-abc" }
    );
  });

  it("does not record a 'claimed' event when the first-eligible-repo scan yields no claim (all repos empty)", async () => {
    getActiveReposMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([]);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("multi-cycle: three runnable tasks across three repos surface one-at-a-time in repo order across successive cycles (AC #112, #116)", async () => {
    // The invariant "at no instant are two tasks 'active' at once" implies
    // that runnable work in a multi-repo setup drains one task per cycle,
    // in the order getActiveRepos returns them. Between cycles we simulate
    // the just-run task finishing (no in-flight active) and it moving out
    // of the eligible pool (next repo's task surfaces).
    const fakeDb = {} as any;

    // getActiveRepos is called once per cycle — configure a stable value.
    getActiveReposMock.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    // Cycle 1: repo 1 has a task, cycle stops as soon as it's claimed.
    claimMock.mockResolvedValueOnce({ id: 101 });
    const cycle1 = await buildWorkQueue(fakeDb, "worker-abc", 1800);
    expect(cycle1).toEqual([{ repoId: 1, taskId: 101 }]);
    expect(claimMock).toHaveBeenLastCalledWith(fakeDb, 1, "worker-abc", 1800);

    // Cycle 2: repo 1 is now empty (task 101 finished), repo 2's task is
    // next in the round-robin. Repo 3 is never consulted this cycle.
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 202 });
    const cycle2 = await buildWorkQueue(fakeDb, "worker-abc", 1800);
    expect(cycle2).toEqual([{ repoId: 2, taskId: 202 }]);

    // Cycle 3: repos 1 and 2 empty, repo 3's task is next.
    claimMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 303 });
    const cycle3 = await buildWorkQueue(fakeDb, "worker-abc", 1800);
    expect(cycle3).toEqual([{ repoId: 3, taskId: 303 }]);

    // Every cycle produced a queue of length ≤ 1 — the single-task invariant.
    // Together the three cycles drained three tasks, in strict repo order.
    expect(cycle1.length + cycle2.length + cycle3.length).toBe(3);
    for (const q of [cycle1, cycle2, cycle3]) {
      expect(q.length).toBeLessThanOrEqual(1);
    }
  });

  it("in-flight guard trips across all repos: even if repo 2 has a runnable task, an active-leased task in repo 1 blocks all new claims (AC #112, #114)", async () => {
    // The single-task invariant is repo-agnostic: an in-flight task in ANY
    // repo blocks new claims in EVERY repo. This is what keeps a queued
    // task in a second repo from being marked 'active' (and leased) while
    // the first repo's task is still running — its lease can never expire
    // while it waits, because it isn't leased at all.
    hasActiveLeasedTaskMock.mockResolvedValueOnce(true);
    getActiveReposMock.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    claimMock.mockResolvedValue({ id: 999 });

    const fakeDb = {} as any;
    const queue = await buildWorkQueue(fakeDb, "worker-abc", 1800);

    expect(queue).toEqual([]);
    expect(claimMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
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
