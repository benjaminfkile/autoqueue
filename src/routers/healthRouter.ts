import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import health from "../db/health";

const healthRouter = express.Router();

/**
 * GET /api/health
 * Returns API liveness and optionally DB connectivity.
 * Pass ?verbose=true to include DB health details.
 */
healthRouter.route("/").get(async (req: Request, res: Response) => {
  try {
    const verbose = req.query.verbose === "true";

    const db = getDb();
    const dbHealth = await health.getDBConnectionHealth(db, verbose);

    res.status(200).json({
      status: "ok",
      error: false,
      db: dbHealth,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: true,
      errorMsg: (error as Error).message,
    });
  }
});

export default healthRouter;
