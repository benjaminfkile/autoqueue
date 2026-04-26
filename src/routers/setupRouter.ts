import express, { Request, Response } from "express";
import * as secrets from "../secrets";

const setupRouter = express.Router();

// Required first-run secrets. The SPA blocks the main UI until each of these
// has a non-empty value in the encrypted secrets store.
export const REQUIRED_SETUP_KEYS = ["ANTHROPIC_API_KEY", "GH_PAT"] as const;
export type RequiredSetupKey = (typeof REQUIRED_SETUP_KEYS)[number];

interface SetupStatus {
  ready: boolean;
  configured: Record<RequiredSetupKey, boolean>;
}

function readStatus(): SetupStatus {
  const configured = {} as Record<RequiredSetupKey, boolean>;
  for (const key of REQUIRED_SETUP_KEYS) {
    const value = secrets.get(key);
    configured[key] = typeof value === "string" && value.length > 0;
  }
  const ready = REQUIRED_SETUP_KEYS.every((k) => configured[k]);
  return { ready, configured };
}

// GET /api/setup — reports whether each required secret is configured so the
// SPA can decide between rendering the onboarding panel and the main UI.
setupRouter.get("/", (_req: Request, res: Response) => {
  try {
    return res.status(200).json(readStatus());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/setup — accepts ANTHROPIC_API_KEY and GH_PAT and persists each
// via secrets.set(). Both must be present and non-empty; partial submissions
// are rejected so the store never ends up half-populated.
setupRouter.post("/", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const provided: Record<RequiredSetupKey, string> = {} as Record<
    RequiredSetupKey,
    string
  >;

  for (const key of REQUIRED_SETUP_KEYS) {
    const raw = body[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return res
        .status(400)
        .json({ error: `${key} is required and must be a non-empty string` });
    }
    provided[key] = raw.trim();
  }

  try {
    for (const key of REQUIRED_SETUP_KEYS) {
      secrets.set(key, provided[key]);
    }
    return res.status(200).json(readStatus());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/setup — clears the required secrets so the SPA falls back to
// the onboarding panel on the next status check. Used by the "reset secrets"
// flow when a user wants to swap in new credentials.
setupRouter.delete("/", (_req: Request, res: Response) => {
  try {
    for (const key of REQUIRED_SETUP_KEYS) {
      secrets.unset(key);
    }
    return res.status(200).json(readStatus());
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default setupRouter;
