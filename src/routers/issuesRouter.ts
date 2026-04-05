import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import {
  deleteIssue,
  getIssuesByRepoId,
  updateIssue,
  upsertIssue,
} from "../db/issues";

const issuesRouter = express.Router();

// GET /api/issues?repo_id= — return all issues for a repo ordered by queue_position
issuesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const repoId = parseInt(req.query.repo_id as string, 10);
    if (isNaN(repoId)) {
      return res.status(400).json({ error: "repo_id query param is required" });
    }

    const db = getDb();
    const issues = await getIssuesByRepoId(db, repoId);
    const sorted = issues.sort((a, b) => a.queue_position - b.queue_position);
    return res.status(200).json(sorted);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/issues — upsert an issue
issuesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const {
      repo_id,
      issue_number,
      parent_issue_number,
      queue_position,
      is_manual,
    } = req.body as {
      repo_id: number;
      issue_number: number;
      parent_issue_number?: number | null;
      queue_position?: number;
      is_manual?: boolean;
    };

    if (!repo_id || !issue_number) {
      return res
        .status(400)
        .json({ error: "repo_id and issue_number are required" });
    }

    const db = getDb();

    let resolvedQueuePosition = queue_position;
    if (resolvedQueuePosition === undefined) {
      const existing = await getIssuesByRepoId(db, repo_id);
      const max =
        existing.length > 0
          ? Math.max(...existing.map((i) => i.queue_position))
          : 0;
      resolvedQueuePosition = max + 1;
    }

    const issue = await upsertIssue(db, {
      repo_id,
      issue_number,
      parent_issue_number: parent_issue_number ?? null,
      queue_position: resolvedQueuePosition,
      is_manual: is_manual ?? false,
    });

    return res.status(201).json(issue);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/issues/:id — update an issue
issuesRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const data = req.body as Partial<{
      queue_position: number;
      status: "pending" | "active" | "done";
      is_manual: boolean;
      parent_issue_number: number | null;
    }>;

    const db = getDb();
    const issue = await updateIssue(db, id, data);
    return res.status(200).json(issue);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/issues/:id — delete an issue
issuesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const db = getDb();
    await deleteIssue(db, id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default issuesRouter;
