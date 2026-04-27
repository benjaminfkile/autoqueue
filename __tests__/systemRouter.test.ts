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

jest.mock("../src/db/appSettings", () => ({
  isPullWorkerPaused: jest.fn(),
  setPullWorkerPaused: jest.fn(),
}));
import { isPullWorkerPaused, setPullWorkerPaused } from "../src/db/appSettings";

jest.mock("../src/services/imageBuilder", () => ({
  RUNNER_IMAGE_NAME: "grunt/runner",
  getRunnerImageState: jest.fn(),
}));
import { getRunnerImageState } from "../src/services/imageBuilder";

jest.mock("../src/services/dockerProbe", () => ({
  DOCKER_INSTALL_URL: "https://www.docker.com/products/docker-desktop/",
  refreshDockerState: jest.fn(),
}));
import { refreshDockerState } from "../src/services/dockerProbe";

import { WORKER_ID } from "../src/services/scheduler";

const ORIGINAL_IS_WORKER = process.env.IS_WORKER;

beforeEach(() => {
  jest.clearAllMocks();
  (getRunnerImageState as jest.Mock).mockReturnValue({
    status: "ready",
    hash: "abc123",
    startedAt: null,
    finishedAt: null,
    error: null,
  });
  (refreshDockerState as jest.Mock).mockResolvedValue({
    available: true,
    error: null,
    lastCheckedAt: null,
  });
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

describe("systemRouter GET /api/system/pull-worker", () => {
  it("returns paused=false when no setting has been written yet", async () => {
    (isPullWorkerPaused as jest.Mock).mockResolvedValue(false);

    const res = await request(app).get("/api/system/pull-worker");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paused: false });
  });

  it("returns paused=true when the worker has been paused via settings", async () => {
    (isPullWorkerPaused as jest.Mock).mockResolvedValue(true);

    const res = await request(app).get("/api/system/pull-worker");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paused: true });
  });

  it("returns 500 with the error message when the settings query throws", async () => {
    (isPullWorkerPaused as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(app).get("/api/system/pull-worker");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db down/);
  });
});

describe("systemRouter GET /api/system/runner-image", () => {
  it("returns the current image build state with snake_case timestamps", async () => {
    (getRunnerImageState as jest.Mock).mockReturnValue({
      status: "building",
      hash: "deadbeef",
      startedAt: "2026-04-26T10:00:00.000Z",
      finishedAt: null,
      error: null,
    });

    const res = await request(app).get("/api/system/runner-image");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      image: "grunt/runner",
      status: "building",
      hash: "deadbeef",
      started_at: "2026-04-26T10:00:00.000Z",
      finished_at: null,
      error: null,
    });
  });

  it("propagates an error message when the build has failed", async () => {
    (getRunnerImageState as jest.Mock).mockReturnValue({
      status: "error",
      hash: "deadbeef",
      startedAt: "2026-04-26T10:00:00.000Z",
      finishedAt: "2026-04-26T10:01:00.000Z",
      error: "docker build exited with code 1",
    });

    const res = await request(app).get("/api/system/runner-image");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.error).toMatch(/docker build/);
  });
});

describe("systemRouter GET /api/system/docker", () => {
  it("returns available=true with no error when the daemon is reachable", async () => {
    (refreshDockerState as jest.Mock).mockResolvedValue({
      available: true,
      error: null,
      lastCheckedAt: "2026-04-26T10:00:00.000Z",
    });

    const res = await request(app).get("/api/system/docker");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      error: null,
      last_checked_at: "2026-04-26T10:00:00.000Z",
      install_url: "https://www.docker.com/products/docker-desktop/",
    });
  });

  it("returns available=false with the captured error when Docker is missing", async () => {
    (refreshDockerState as jest.Mock).mockResolvedValue({
      available: false,
      error: "Docker is not installed or not on PATH",
      lastCheckedAt: "2026-04-26T10:00:00.000Z",
    });

    const res = await request(app).get("/api/system/docker");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.error).toMatch(/not installed/);
    expect(res.body.install_url).toBe(
      "https://www.docker.com/products/docker-desktop/"
    );
  });

  it("returns 500 with the error message when the probe throws unexpectedly", async () => {
    (refreshDockerState as jest.Mock).mockRejectedValue(
      new Error("spawn failed")
    );

    const res = await request(app).get("/api/system/docker");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/spawn failed/);
  });
});

describe("systemRouter PATCH /api/system/pull-worker", () => {
  it("persists paused=true and echoes the new state", async () => {
    (setPullWorkerPaused as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .patch("/api/system/pull-worker")
      .send({ paused: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paused: true });
    expect(setPullWorkerPaused).toHaveBeenCalledWith(
      expect.anything(),
      true
    );
  });

  it("persists paused=false (resume)", async () => {
    (setPullWorkerPaused as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .patch("/api/system/pull-worker")
      .send({ paused: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paused: false });
    expect(setPullWorkerPaused).toHaveBeenCalledWith(
      expect.anything(),
      false
    );
  });

  it("rejects non-boolean paused values with a 400", async () => {
    const res = await request(app)
      .patch("/api/system/pull-worker")
      .send({ paused: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/paused must be boolean/);
    expect(setPullWorkerPaused).not.toHaveBeenCalled();
  });

  it("returns 500 with the error message when the persistence write throws", async () => {
    (setPullWorkerPaused as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(app)
      .patch("/api/system/pull-worker")
      .send({ paused: true });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db down/);
  });
});
