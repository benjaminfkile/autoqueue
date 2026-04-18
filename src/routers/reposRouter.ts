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

// POST /api/repos — create a repo
reposRouter.post("/", async (req: Request, res: Response) => {
  try {
    const db = getDb();

    const { owner, repo_name, active, base_branch, require_pr, github_token } = req.body as {
      owner: string;
      repo_name: string;
      active?: boolean;
      base_branch?: string;
      require_pr?: boolean;
      github_token?: string | null;
    };

    if (!owner || !repo_name) {
      return res.status(400).json({ error: "owner and repo_name are required" });
    }

    const existing = await getRepoByOwnerAndName(db, owner, repo_name);
    if (existing) {
      return res.status(409).json({ error: "Repo already exists" });
    }

    const isActive = active !== false;
    const repo = await createRepo(db, { owner, repo_name, active: isActive, base_branch, require_pr, github_token });

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
      base_branch: string;
      require_pr: boolean;
      github_token: string | null;
    }>;

    const updated = await updateRepo(db, id, data);

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/repos/:id/advance — manually kick the queue for a repo (stub — queue logic pending)
reposRouter.post("/:id/advance", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    const existing = await getRepoById(db, id);
    if (!existing) {
      return res.status(404).json({ error: "Repo not found" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/repos/:id — delete a repo
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

    await deleteRepo(db, id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default reposRouter;
