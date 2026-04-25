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
import { IAppSecrets, RepoOnFailure, RepoOnParentChildFail } from "../interfaces";

const VALID_ON_FAILURE: RepoOnFailure[] = [
  "halt_repo",
  "halt_subtree",
  "retry",
  "continue",
];
const VALID_ON_PARENT_CHILD_FAIL: RepoOnParentChildFail[] = [
  "cascade_fail",
  "mark_partial",
  "ignore",
];

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

    const {
      owner,
      repo_name,
      active,
      base_branch,
      base_branch_parent,
      require_pr,
      github_token,
      is_local_folder,
      local_path,
      on_failure,
      max_retries,
      on_parent_child_fail,
    } = req.body as {
      owner?: string;
      repo_name?: string;
      active?: boolean;
      base_branch?: string;
      base_branch_parent?: string;
      require_pr?: boolean;
      github_token?: string | null;
      is_local_folder?: boolean;
      local_path?: string | null;
      on_failure?: RepoOnFailure;
      max_retries?: number;
      on_parent_child_fail?: RepoOnParentChildFail;
    };

    if (!is_local_folder && (!owner || !repo_name)) {
      return res.status(400).json({ error: "owner and repo_name are required" });
    }

    if (on_failure !== undefined && !VALID_ON_FAILURE.includes(on_failure)) {
      return res.status(400).json({ error: "Invalid on_failure" });
    }
    if (
      on_parent_child_fail !== undefined &&
      !VALID_ON_PARENT_CHILD_FAIL.includes(on_parent_child_fail)
    ) {
      return res.status(400).json({ error: "Invalid on_parent_child_fail" });
    }
    if (
      max_retries !== undefined &&
      (!Number.isInteger(max_retries) || max_retries < 0)
    ) {
      return res
        .status(400)
        .json({ error: "max_retries must be a non-negative integer" });
    }

    if (!is_local_folder) {
      const existing = await getRepoByOwnerAndName(db, owner as string, repo_name as string);
      if (existing) {
        return res.status(409).json({ error: "Repo already exists" });
      }
    }

    const isActive = active !== false;
    const repo = await createRepo(db, {
      owner,
      repo_name,
      active: isActive,
      base_branch,
      base_branch_parent,
      require_pr,
      github_token,
      is_local_folder,
      local_path,
      on_failure,
      max_retries,
      on_parent_child_fail,
    });

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
      base_branch_parent: string;
      require_pr: boolean;
      github_token: string | null;
      is_local_folder: boolean;
      local_path: string | null;
      on_failure: RepoOnFailure;
      max_retries: number;
      on_parent_child_fail: RepoOnParentChildFail;
    }>;

    if (
      data.on_failure !== undefined &&
      !VALID_ON_FAILURE.includes(data.on_failure)
    ) {
      return res.status(400).json({ error: "Invalid on_failure" });
    }
    if (
      data.on_parent_child_fail !== undefined &&
      !VALID_ON_PARENT_CHILD_FAIL.includes(data.on_parent_child_fail)
    ) {
      return res.status(400).json({ error: "Invalid on_parent_child_fail" });
    }
    if (
      data.max_retries !== undefined &&
      (!Number.isInteger(data.max_retries) || data.max_retries < 0)
    ) {
      return res
        .status(400)
        .json({ error: "max_retries must be a non-negative integer" });
    }

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
