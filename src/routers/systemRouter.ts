import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import { getActiveWorkers } from "../db/workers";
import { WORKER_ID } from "../services/scheduler";
import { IAppSecrets } from "../interfaces";

const systemRouter = express.Router();

/**
 * GET /api/system/worker-status
 * Returns the running mode (worker vs orchestrator-only) for this instance and
 * the list of currently active workers across the cluster (active task + lease).
 */
systemRouter.get("/worker-status", async (req: Request, res: Response) => {
  try {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    const isWorker = secrets?.IS_WORKER === "true";

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

export default systemRouter;
