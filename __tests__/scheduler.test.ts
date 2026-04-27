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

import { getActiveRepos } from "../src/db/repos";
import { claimNextPendingLeafTask } from "../src/db/tasks";
import { recordEvent } from "../src/db/taskEvents";
import { buildWorkQueue, WORKER_ID } from "../src/services/scheduler";

const getActiveReposMock = getActiveRepos as jest.Mock;
const claimMock = claimNextPendingLeafTask as jest.Mock;
const recordEventMock = recordEvent as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
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
});
