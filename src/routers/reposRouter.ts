import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import {
  createRepo,
  deleteRepo,
  getAllRepos,
  getRepoByOwnerAndName,
  getRepoById,
  updateRepo,
} from "../db/repos";
import { IAppSecrets } from "../interfaces";
import { deregisterWebhook, registerWebhook } from "../services/github";

const reposRouter = express.Router();

// GET /api/repos — return all repos
reposRouter.get("/", async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const repos = await getAllRepos(db);
    return res.status(200).json(repos);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos — create a repo (and register webhook if active)
reposRouter.post("/", async (req: Request, res: Response) => {
  try {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    const { owner, repo_name, active } = req.body as {
      owner: string;
      repo_name: string;
      active?: boolean;
    };

    if (!owner || !repo_name) {
      return res.status(400).json({ error: "owner and repo_name are required" });
    }

    const db = getDb();

    const existing = await getRepoByOwnerAndName(db, owner, repo_name);
    if (existing) {
      return res.status(409).json({ error: "Repo already exists" });
    }

    const isActive = active !== false;
    const repo = await createRepo(db, { owner, repo_name, active: isActive });

    if (isActive) {
      try {
        const webhookUrl = `${secrets.BASE_URL}/api/webhook`;
        const webhookId = await registerWebhook(
          secrets.GH_PAT,
          owner,
          repo_name,
          webhookUrl,
          secrets.WEBHOOK_SECRET
        );
        const updated = await updateRepo(db, repo.id, { webhook_id: webhookId });
        return res.status(201).json(updated);
      } catch (err) {
        console.error("[reposRouter] registerWebhook failed:", err);
        return res.status(201).json(repo);
      }
    }

    return res.status(201).json(repo);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/repos/:id — update a repo
reposRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    const data = req.body as Partial<{
      active: boolean;
      owner: string;
      repo_name: string;
    }>;

    let updated = await updateRepo(db, id, data);

    // Handle webhook registration/deregistration based on active flag change
    if (typeof data.active === "boolean") {
      if (!data.active && existing.webhook_id != null) {
        // Deregister webhook and clear webhook_id
        try {
          await deregisterWebhook(
            secrets.GH_PAT,
            updated.owner,
            updated.repo_name,
            existing.webhook_id
          );
        } catch (err) {
          console.error("[reposRouter] deregisterWebhook failed:", err);
        }
        updated = await updateRepo(db, id, { webhook_id: null });
      } else if (data.active && updated.webhook_id == null) {
        // Register webhook and save id
        try {
          const webhookUrl = `${secrets.BASE_URL}/api/webhook`;
          const webhookId = await registerWebhook(
            secrets.GH_PAT,
            updated.owner,
            updated.repo_name,
            webhookUrl,
            secrets.WEBHOOK_SECRET
          );
          updated = await updateRepo(db, id, { webhook_id: webhookId });
        } catch (err) {
          console.error("[reposRouter] registerWebhook failed:", err);
        }
      }
    }

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/repos/:id — delete a repo (deregister webhook if present)
reposRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    if (existing.webhook_id != null) {
      try {
        await deregisterWebhook(
          secrets.GH_PAT,
          existing.owner,
          existing.repo_name,
          existing.webhook_id
        );
      } catch (err) {
        console.error("[reposRouter] deregisterWebhook failed:", err);
      }
    }

    await deleteRepo(db, id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default reposRouter;
