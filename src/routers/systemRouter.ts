import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import { getActiveWorkers } from "../db/workers";
import { WORKER_ID } from "../services/scheduler";
import { isPullWorkerPaused, setPullWorkerPaused } from "../db/appSettings";

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

export default systemRouter;
