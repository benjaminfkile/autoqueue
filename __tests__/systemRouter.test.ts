import request from "supertest";
import app from "../src/app";

jest.mock("../src/db/db", () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock("../src/db/health", () => ({
  __esModule: true,
  default: {
    getDBConnectionHealth: jest.fn().mockResolvedValue({
      connected: true,
      connectionUsesProxy: false,
    }),
  },
}));

jest.mock("../src/db/workers");
import { getActiveWorkers } from "../src/db/workers";

import { WORKER_ID } from "../src/services/scheduler";

const ORIGINAL_IS_WORKER = process.env.IS_WORKER;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_IS_WORKER === undefined) {
    delete process.env.IS_WORKER;
  } else {
    process.env.IS_WORKER = ORIGINAL_IS_WORKER;
  }
});

describe("systemRouter GET /api/system/worker-status", () => {
  it("reports orchestrator mode and an empty active_workers list when no workers are leased", async () => {
    process.env.IS_WORKER = "false";
    (getActiveWorkers as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get("/api/system/worker-status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "orchestrator",
      this_worker_id: null,
      active_workers: [],
    });
    expect(getActiveWorkers).toHaveBeenCalled();
  });

  it("reports worker mode with this instance's worker id and serializes active workers", async () => {
    process.env.IS_WORKER = "true";
    const lease1 = new Date("2026-04-25T12:34:56Z");
    const lease2 = new Date("2026-04-25T12:35:00Z");
    (getActiveWorkers as jest.Mock).mockResolvedValue([
      {
        worker_id: WORKER_ID,
        task_id: 1,
        task_title: "Self task",
        repo_id: 10,
        leased_until: lease1,
      },
      {
        worker_id: "other-host:9999",
        task_id: 2,
        task_title: "Other task",
        repo_id: 11,
        leased_until: lease2,
      },
    ]);

    const res = await request(app).get("/api/system/worker-status");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("worker");
    expect(res.body.this_worker_id).toBe(WORKER_ID);
    expect(res.body.active_workers).toHaveLength(2);
    expect(res.body.active_workers[0]).toEqual({
      worker_id: WORKER_ID,
      task_id: 1,
      task_title: "Self task",
      repo_id: 10,
      leased_until: lease1.toISOString(),
      is_self: true,
    });
    expect(res.body.active_workers[1]).toEqual({
      worker_id: "other-host:9999",
      task_id: 2,
      task_title: "Other task",
      repo_id: 11,
      leased_until: lease2.toISOString(),
      is_self: false,
    });
  });

  it("never marks a worker as is_self when this instance is not a worker", async () => {
    process.env.IS_WORKER = "false";
    (getActiveWorkers as jest.Mock).mockResolvedValue([
      {
        worker_id: WORKER_ID,
        task_id: 1,
        task_title: "Whatever",
        repo_id: 10,
        leased_until: new Date("2026-04-25T13:00:00Z"),
      },
    ]);

    const res = await request(app).get("/api/system/worker-status");

    expect(res.status).toBe(200);
    expect(res.body.this_worker_id).toBeNull();
    expect(res.body.active_workers[0].is_self).toBe(false);
  });

  it("coerces non-Date leased_until values to a string", async () => {
    process.env.IS_WORKER = "true";
    (getActiveWorkers as jest.Mock).mockResolvedValue([
      {
        worker_id: "host:1",
        task_id: 5,
        task_title: "T",
        repo_id: 1,
        leased_until: "2026-04-25T13:00:00Z",
      },
    ]);

    const res = await request(app).get("/api/system/worker-status");

    expect(res.status).toBe(200);
    expect(res.body.active_workers[0].leased_until).toBe(
      "2026-04-25T13:00:00Z"
    );
  });

  it("returns 500 with the error message when the workers query throws", async () => {
    process.env.IS_WORKER = "true";
    (getActiveWorkers as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(app).get("/api/system/worker-status");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db down/);
  });

});
