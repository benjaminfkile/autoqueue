import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import { getSettings, updateSettings } from "../db/settings";

const settingsRouter = express.Router();

// GET /api/settings — returns the single-row settings record so the SPA can
// display the current default_model in the settings panel.
settingsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings(getDb());
    return res.status(200).json(settings);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/settings — partial update of the single-row settings record.
// Currently only default_model is patchable; unknown keys are ignored so
// future columns can be added without breaking older clients.
settingsRouter.patch("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { default_model?: string } = {};

  if (Object.prototype.hasOwnProperty.call(body, "default_model")) {
    const raw = body.default_model;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "default_model must be a non-empty string" });
    }
    patch.default_model = raw.trim();
  }

  if (Object.keys(patch).length === 0) {
    return res
      .status(400)
      .json({ error: "At least one settings field must be provided" });
  }

  try {
    const settings = await updateSettings(getDb(), patch);
    return res.status(200).json(settings);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default settingsRouter;
