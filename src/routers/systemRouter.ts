import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import { getActiveWorkers } from "../db/workers";
import { WORKER_ID } from "../services/scheduler";
import { isPullWorkerPaused, setPullWorkerPaused } from "../db/appSettings";
import {
  getRunnerImageState,
  RUNNER_IMAGE_NAME,
} from "../services/imageBuilder";
import {
  DOCKER_INSTALL_URL,
  refreshDockerState,
} from "../services/dockerProbe";

const systemRouter = express.Router();

/**
 * GET /api/system/worker-status
 * Returns the running mode (worker vs orchestrator-only) for this instance and
 * the list of currently active workers across the cluster (active task + lease).
 */
systemRouter.get("/worker-status", async (_req: Request, res: Response) => {
  try {
    const isWorker = process.env.IS_WORKER === "true";

    const db = getDb();
    const rows = await getActiveWorkers(db);

    const active_workers = rows.map((row) => ({
      worker_id: row.worker_id,
      task_id: row.task_id,
      task_title: row.task_title,
      repo_id: row.repo_id,
      leased_until:
        row.leased_until instanceof Date
          ? row.leased_until.toISOString()
          : String(row.leased_until),
      is_self: isWorker && row.worker_id === WORKER_ID,
    }));

    return res.status(200).json({
      mode: isWorker ? "worker" : "orchestrator",
      this_worker_id: isWorker ? WORKER_ID : null,
      active_workers,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/system/pull-worker
 * Reports whether the background clone-refresh worker is currently paused.
 */
systemRouter.get("/pull-worker", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const paused = await isPullWorkerPaused(db);
    return res.status(200).json({ paused });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PATCH /api/system/pull-worker
 * Pauses or resumes the background pull worker. The flag is persisted in the
 * app_settings table so the choice survives restarts.
 */
systemRouter.patch("/pull-worker", async (req: Request, res: Response) => {
  try {
    const { paused } = req.body as { paused?: unknown };
    if (typeof paused !== "boolean") {
      return res.status(400).json({ error: "paused must be boolean" });
    }
    const db = getDb();
    await setPullWorkerPaused(db, paused);
    return res.status(200).json({ paused });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/system/docker
 * Reports whether the local Docker daemon is reachable. The SPA polls this so
 * it can render a "Docker Desktop not running — install/start it" banner and
 * link the user to the install page when the worker is paused for missing
 * Docker. Each request triggers a fresh `docker version` probe (throttled
 * inside the service) so the banner reflects current daemon state, not a
 * stale snapshot.
 */
systemRouter.get("/docker", async (_req: Request, res: Response) => {
  try {
    const s = await refreshDockerState();
    return res.status(200).json({
      available: s.available,
      error: s.error,
      last_checked_at: s.lastCheckedAt,
      install_url: DOCKER_INSTALL_URL,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/system/runner-image
 * Reports the current state of the grunt/runner Docker image build. The GUI
 * polls this so it can show a "building image, this may take a few minutes"
 * banner on first install / after Dockerfile changes.
 */
systemRouter.get("/runner-image", (_req: Request, res: Response) => {
  const s = getRunnerImageState();
  return res.status(200).json({
    image: RUNNER_IMAGE_NAME,
    status: s.status,
    hash: s.hash,
    started_at: s.startedAt,
    finished_at: s.finishedAt,
    error: s.error,
  });
});

export default systemRouter;
