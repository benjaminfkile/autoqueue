import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import { getSettings } from "../db/settings";
import {
  getDailyTokens,
  getWeeklyTokens,
} from "../db/usageAggregations";

const usageRouter = express.Router();

// GET /api/usage/weekly — drives the SPA usage dashboard. Returns:
//   - weekly_total: trailing-7-day token sum (input + output + cache_*)
//   - weekly_cap: settings.weekly_token_cap (null = unlimited)
//   - daily: trailing-30-day per-day token totals, zero-filled for empty days
//
// Per-repo breakdown is intentionally NOT in this payload — the dashboard
// fetches it via the existing GET /api/repos/:id/usage so cards can share
// rendering logic with the repo list and task detail panes (same response
// shape, same UsagePanel component).
//
// `now` is captured once per request so the trailing windows are consistent
// (a 7-day total and a 30-day chart computed against different instants would
// show divergent numbers near midnight).
usageRouter.get("/weekly", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const now = new Date();
    const [settings, weekly, daily] = await Promise.all([
      getSettings(db),
      getWeeklyTokens(db, now),
      getDailyTokens(db, now, 30),
    ]);
    return res.status(200).json({
      weekly_total: weekly.total,
      weekly_cap: settings.weekly_token_cap,
      weekly_breakdown: {
        input: weekly.input,
        output: weekly.output,
        cache_creation: weekly.cache_creation,
        cache_read: weekly.cache_read,
      },
      daily,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default usageRouter;
